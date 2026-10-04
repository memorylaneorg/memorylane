"""One explicitly selected Photos image, with a killable bounded PhotoKit worker.

PhotoKit may maintain its own iCloud cache. We never request original resources,
change Photos preferences, export a library, or enumerate assets for downloads.
"""
import base64
import json
import os
import signal
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from .catalog import validate_library

MAX_BYTES = 32 * 1024 * 1024
CAPABILITY = {'version': 1, 'maxWidth': 3840, 'maxHeight': 2160, 'maxBytes': MAX_BYTES}


class PreparationError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def validate_photo(library_path, uuid):
    import osxphotos
    library = validate_library(library_path)
    system = osxphotos.get_system_library_path()
    if not system or Path(system).resolve() != library:
        raise PreparationError('system_library_required', 'Viewing copies require the selected library to be the System Photo Library. Open this library in Photos and choose Use as System Photo Library in Photos Settings, then retry.')
    photo = osxphotos.PhotosDB(str(library)).get_photo(uuid)
    if (photo is None or str(photo.uuid) != uuid or photo.hidden or photo.intrash
            or not photo.isphoto or photo.ismovie):
        raise PreparationError('unavailable', 'The selected photo is no longer a visible still image in this library.')
    return library


class PreparationManager:
    def __init__(self, root, command, deadline=120):
        self.root = Path(root)
        self.command = command
        self.deadline = deadline
        self.lock = threading.Lock()
        self.active = None
        self.closed = False

    def close(self):
        with self.lock:
            self.closed = True
            job = self.active
        if job is not None:
            self.cancel(job["id"])

    def cancel(self, job_id):
        process = None
        with self.lock:
            job = self.active
            if job is not None and job['id'] == job_id:
                job['cancelled'] = True
                process = job['process']
        if process is not None:
            self.stop(process)

    @staticmethod
    def stop(process):
        if process.poll() is None:
            process.terminate()
            try: process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

    def prepare(self, job_id, library_path, uuid):
        if not all(isinstance(value, str) and 0 < len(value) <= 4096 for value in (job_id, library_path, uuid)):
            raise PreparationError('invalid_request', 'A job ID, library path and photo UUID are required.')
        job = {'id': job_id, 'process': None, 'cancelled': False}
        with self.lock:
            if self.closed:
                raise PreparationError('unavailable', 'Photo preparation is shutting down.')
            if self.active is not None:
                raise PreparationError('busy', 'A photo preparation is already running. Retry shortly.')
            self.active = job
        process = None
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix='prepare-', dir=self.root) as tmp:
                try:
                    with self.lock:
                        if job['cancelled']:
                            raise PreparationError('cancelled', 'Photo preparation was cancelled.')
                        env = dict(os.environ, TMPDIR=tmp, TMP=tmp, TEMP=tmp)
                        process = subprocess.Popen(self.command + ['--prepare-one', library_path, uuid, tmp],
                                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                                   stderr=subprocess.DEVNULL, env=env)
                        job['process'] = process
                    try: process.wait(timeout=self.deadline)
                    except subprocess.TimeoutExpired:
                        self.stop(process)
                        raise PreparationError('timeout', 'Photo preparation timed out. Check iCloud connectivity and retry.')
                    if job['cancelled']:
                        raise PreparationError('cancelled', 'Photo preparation was cancelled.')
                    if process.returncode != 0:
                        error_path = Path(tmp) / 'error.json'
                        if error_path.exists() and error_path.stat().st_size <= 8192:
                            error = json.loads(error_path.read_text())
                            raise PreparationError(error['code'], error['error'])
                        raise PreparationError('unavailable', 'Photos could not prepare this image. Check Photos access and retry.')
                    output = Path(tmp) / 'image.jpg'
                    if not output.is_file() or not 4 <= output.stat().st_size <= MAX_BYTES:
                        raise PreparationError('size_limit', 'Prepared image exceeds the supported size limit.')
                    data = output.read_bytes()
                    if not data.startswith(b'\xff\xd8') or not data.endswith(b'\xff\xd9'):
                        raise PreparationError('invalid_image', 'Photos returned an invalid viewing image.')
                    return {'jpeg_base64': base64.b64encode(data).decode('ascii')}
                finally:
                    if process is not None: self.stop(process)
        finally:
            with self.lock:
                self.active = None


def _jpeg(image):
    # Draw the oriented PhotoKit NSImage into a NEW pixel buffer. No source
    # EXIF/IPTC/GPS dictionaries are copied to the JPEG encoder.
    import AppKit
    width, height = image.size()
    if width <= 0 or height <= 0:
        raise PreparationError('invalid_image', 'Photos returned an empty image.')
    scale = min(1, 3840 / width, 2160 / height)
    width, height = max(1, int(width * scale)), max(1, int(height * scale))
    bitmap = AppKit.NSBitmapImageRep.alloc().initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel_(
        None, width, height, 8, 3, False, False, AppKit.NSDeviceRGBColorSpace, 0, 0)
    AppKit.NSGraphicsContext.saveGraphicsState()
    try:
        AppKit.NSGraphicsContext.setCurrentContext_(AppKit.NSGraphicsContext.graphicsContextWithBitmapImageRep_(bitmap))
        image.drawInRect_fromRect_operation_fraction_(((0, 0), (width, height)), ((0, 0), (0, 0)), AppKit.NSCompositeCopy, 1.0)
    finally:
        AppKit.NSGraphicsContext.restoreGraphicsState()
    data = bitmap.representationUsingType_properties_(AppKit.NSBitmapImageFileTypeJPEG, {AppKit.NSImageCompressionFactor: 0.9})
    if data is None or data.length() > MAX_BYTES:
        raise PreparationError('size_limit', 'Prepared image exceeds the supported size limit.')
    return bytes(data)


def authorize_photos(cancelled):
    """Request macOS permission only as part of an explicit preparation action.

    TCC attributes helper requests to the responsible app (or development
    terminal). The packaged MemoryLane app declares the Photos usage reason.
    """
    import Photos
    import Foundation
    status = Photos.PHPhotoLibrary.authorizationStatus()
    if status == Photos.PHAuthorizationStatusNotDetermined:
        done = threading.Event()
        result = {}
        def authorized(value):
            result['status'] = value
            done.set()
        Photos.PHPhotoLibrary.requestAuthorization_(authorized)
        deadline = time.monotonic() + 45
        while not done.is_set():
            if cancelled.is_set():
                raise PreparationError('cancelled', 'Photo preparation was cancelled.')
            if time.monotonic() >= deadline:
                raise PreparationError('permission_required', 'Respond to the macOS Photos permission request for MemoryLane (or the terminal running it), then retry.')
            Foundation.NSRunLoop.currentRunLoop().runUntilDate_(Foundation.NSDate.dateWithTimeIntervalSinceNow_(0.05))
        status = result['status']
    if status != Photos.PHAuthorizationStatusAuthorized:
        raise PreparationError('permission_required', 'Allow Photos access for MemoryLane (or the terminal running it) in System Settings > Privacy & Security > Photos, then retry.')


def prepare_one(library_path, uuid, output_dir):
    """Runs only in the disposable child, never in the HTTP handler process."""
    cancelled = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: cancelled.set())
    validate_photo(library_path, uuid)
    import Photos
    import Foundation
    authorize_photos(cancelled)
    if cancelled.is_set(): raise PreparationError('cancelled', 'Photo preparation was cancelled.')
    assets = Photos.PHAsset.fetchAssetsWithLocalIdentifiers_options_([uuid], None)
    if assets.count() != 1:
        raise PreparationError('unavailable', 'This photo is unavailable in the System Photo Library.')
    asset = assets.objectAtIndex_(0)
    if asset.mediaType() != Photos.PHAssetMediaTypeImage or asset.isHidden() or str(asset.localIdentifier()).split('/')[0] != uuid:
        raise PreparationError('unavailable', 'The selected photo is no longer a visible still image.')
    options = Photos.PHImageRequestOptions.alloc().init()
    options.setNetworkAccessAllowed_(True)
    options.setSynchronous_(False)
    options.setDeliveryMode_(Photos.PHImageRequestOptionsDeliveryModeHighQualityFormat)
    options.setResizeMode_(Photos.PHImageRequestOptionsResizeModeExact)
    options.setVersion_(Photos.PHImageRequestOptionsVersionCurrent)
    done = threading.Event()
    result = {}
    def complete(image, info):
        info = info or {}
        if info.get(Photos.PHImageResultIsDegradedKey): return
        result['image'] = image
        result['error'] = info.get(Photos.PHImageErrorKey)
        done.set()
    manager = Photos.PHImageManager.defaultManager()
    request = manager.requestImageForAsset_targetSize_contentMode_options_resultHandler_(asset, (3840, 2160), Photos.PHImageContentModeAspectFit, options, complete)
    try:
        deadline = time.monotonic() + 110
        while not done.is_set():
            if cancelled.is_set(): raise PreparationError('cancelled', 'Photo preparation was cancelled.')
            if time.monotonic() >= deadline: raise PreparationError('timeout', 'Photo preparation timed out. Check iCloud connectivity and retry.')
            Foundation.NSRunLoop.currentRunLoop().runUntilDate_(Foundation.NSDate.dateWithTimeIntervalSinceNow_(0.05))
        if cancelled.is_set(): raise PreparationError('cancelled', 'Photo preparation was cancelled.')
        if result.get('error') or result.get('image') is None:
            raise PreparationError('unavailable', 'iCloud could not supply this photo. Open it in Photos, check connectivity, and retry.')
        # Detect library changes during the request before accepting its pixels.
        import osxphotos
        if Path(osxphotos.get_system_library_path() or '').resolve() != Path(library_path).expanduser().resolve():
            raise PreparationError('system_library_required', 'The System Photo Library changed. Select the correct library and retry.')
        Path(output_dir, 'image.jpg').write_bytes(_jpeg(result['image']))
    finally:
        manager.cancelImageRequest_(request)


def worker_main(library_path, uuid, output_dir):
    try:
        prepare_one(library_path, uuid, output_dir)
        return 0
    except Exception as error:
        payload = {'code': getattr(error, 'code', 'unavailable'), 'error': str(error)[:2000]}
        Path(output_dir, 'error.json').write_text(json.dumps(payload))
        return 1
