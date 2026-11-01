import base64
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from memorylane_photos import prepare


class PreparationTests(unittest.TestCase):
    def test_requires_exact_system_library_and_visible_still(self):
        with tempfile.TemporaryDirectory() as tmp:
            library = Path(tmp) / 'a.photoslibrary'
            (library / 'database').mkdir(parents=True)
            (library / 'database' / 'Photos.sqlite').touch()
            photo = SimpleNamespace(uuid='id', hidden=False, intrash=False, isphoto=True, ismovie=False)
            api = SimpleNamespace(get_system_library_path=lambda: str(library), PhotosDB=lambda _: SimpleNamespace(get_photo=lambda _: photo))
            with patch.dict(sys.modules, {'osxphotos': api}):
                self.assertEqual(prepare.validate_photo(str(library), 'id'), library.resolve())
                photo.hidden = True
                with self.assertRaisesRegex(prepare.PreparationError, 'visible'):
                    prepare.validate_photo(str(library), 'id')
                photo.hidden = False
                photo.ismovie = True
                with self.assertRaises(prepare.PreparationError):
                    prepare.validate_photo(str(library), 'id')
                api.get_system_library_path = lambda: str(Path(tmp) / 'other.photoslibrary')
                with self.assertRaisesRegex(prepare.PreparationError, 'System Photo Library'):
                    prepare.validate_photo(str(library), 'id')

    def test_output_and_scratch_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / 'worker.py'
            script.write_text("import pathlib,sys; pathlib.Path(sys.argv[-1], 'image.jpg').write_bytes(b'\\xff\\xd8ok\\xff\\xd9')")
            manager = prepare.PreparationManager(Path(tmp) / 'jobs', [sys.executable, str(script)])
            self.assertEqual(base64.b64decode(manager.prepare('one', '/library', 'id')['jpeg_base64']), b'\xff\xd8ok\xff\xd9')
            self.assertEqual(list((Path(tmp) / 'jobs').iterdir()), [])

    def test_cancel_stops_worker_and_rejects_concurrent_requests(self):
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / 'worker.py'
            script.write_text('import signal,time; signal.signal(signal.SIGTERM, lambda *_: None); time.sleep(30)')
            manager = prepare.PreparationManager(Path(tmp) / 'jobs', [sys.executable, str(script)])
            errors = []
            def run():
                try: manager.prepare('one', '/library', 'id')
                except prepare.PreparationError as error: errors.append(error.code)
            thread = threading.Thread(target=run)
            thread.start()
            for _ in range(100):
                if manager.active is not None: break
                time.sleep(.01)
            with self.assertRaisesRegex(prepare.PreparationError, 'already'):
                manager.prepare('two', '/library', 'id')
            time.sleep(.15)
            manager.cancel('one')
            thread.join(5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, ['cancelled'])
            self.assertEqual(list((Path(tmp) / 'jobs').iterdir()), [])

    def test_closed_manager_rejects_new_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = prepare.PreparationManager(Path(tmp), [sys.executable])
            manager.close()
            with self.assertRaisesRegex(prepare.PreparationError, 'shutting down'):
                manager.prepare('one', '/library', 'id')

    def test_timeout_and_output_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / 'worker.py'
            script.write_text('import time; time.sleep(30)')
            manager = prepare.PreparationManager(Path(tmp) / 'jobs', [sys.executable, str(script)], deadline=.1)
            with self.assertRaisesRegex(prepare.PreparationError, 'timed out'):
                manager.prepare('one', '/library', 'id')
            script.write_text("import pathlib,sys; pathlib.Path(sys.argv[-1], 'image.jpg').write_bytes(b'x'*100)")
            with patch.object(prepare, 'MAX_BYTES', 20):
                with self.assertRaisesRegex(prepare.PreparationError, 'size'):
                    manager.prepare('two', '/library', 'id')
            self.assertEqual(list((Path(tmp) / 'jobs').iterdir()), [])

class PhotoKitContractTests(unittest.TestCase):
    def test_requests_only_selected_uuid_at_tv_size_and_cancels_native_request(self):
        from unittest.mock import MagicMock
        photos = MagicMock()
        photos.PHAuthorizationStatusAuthorized = 3
        photos.PHAssetMediaTypeImage = 1
        photos.PHImageResultIsDegradedKey = 'degraded'
        photos.PHImageErrorKey = 'error'
        photos.PHPhotoLibrary.authorizationStatus.return_value = 3
        asset = photos.PHAsset.fetchAssetsWithLocalIdentifiers_options_.return_value
        asset.count.return_value = 1
        asset.objectAtIndex_.return_value.mediaType.return_value = 1
        asset.objectAtIndex_.return_value.isHidden.return_value = False
        asset.objectAtIndex_.return_value.localIdentifier.return_value = 'id/L0/001'
        manager = photos.PHImageManager.defaultManager.return_value
        image = object()
        def request(_asset, size, _mode, _options, callback):
            self.assertEqual(size, (3840, 2160))
            callback(None, {'degraded': True})
            callback(image, {})
            return 42
        manager.requestImageForAsset_targetSize_contentMode_options_resultHandler_.side_effect = request
        with tempfile.TemporaryDirectory() as tmp:
            library = Path(tmp).resolve()
            api = SimpleNamespace(get_system_library_path=lambda: str(library))
            with patch.dict(sys.modules, {'Photos': photos, 'Foundation': MagicMock(), 'osxphotos': api}), patch.object(prepare, 'validate_photo'), patch.object(prepare.signal, 'signal'), patch.object(prepare, '_jpeg', return_value=b'jpeg'):
                prepare.prepare_one(str(library), 'id', tmp)
            self.assertEqual((Path(tmp) / 'image.jpg').read_bytes(), b'jpeg')
        photos.PHAsset.fetchAssetsWithLocalIdentifiers_options_.assert_called_once_with(['id'], None)
        photos.PHImageRequestOptions.alloc.return_value.init.return_value.setNetworkAccessAllowed_.assert_called_once_with(True)
        manager.cancelImageRequest_.assert_called_once_with(42)
        photos.PHAssetResourceManager.assert_not_called()

    def test_authorization_requested_only_when_not_determined(self):
        from unittest.mock import MagicMock
        photos = MagicMock()
        photos.PHAuthorizationStatusAuthorized = 3
        photos.PHAuthorizationStatusNotDetermined = 0
        photos.PHPhotoLibrary.authorizationStatus.return_value = 0
        photos.PHPhotoLibrary.requestAuthorization_.side_effect = lambda callback: callback(3)
        with patch.dict(sys.modules, {'Photos': photos, 'Foundation': MagicMock()}):
            prepare.authorize_photos(threading.Event())
            photos.PHPhotoLibrary.requestAuthorization_.assert_called_once()
            photos.PHPhotoLibrary.requestAuthorization_.reset_mock()
            photos.PHPhotoLibrary.authorizationStatus.return_value = 3
            prepare.authorize_photos(threading.Event())
            photos.PHPhotoLibrary.requestAuthorization_.assert_not_called()
            photos.PHPhotoLibrary.authorizationStatus.return_value = 2
            with self.assertRaisesRegex(prepare.PreparationError, 'Allow Photos access'):
                prepare.authorize_photos(threading.Event())
            photos.PHPhotoLibrary.requestAuthorization_.assert_not_called()

    def test_no_request_when_photos_permission_is_missing(self):
        from unittest.mock import MagicMock
        photos = MagicMock()
        photos.PHAuthorizationStatusAuthorized = 3
        photos.PHPhotoLibrary.authorizationStatus.return_value = 2
        with patch.dict(sys.modules, {'Photos': photos, 'Foundation': MagicMock()}), patch.object(prepare, 'validate_photo'), patch.object(prepare.signal, 'signal'):
            with self.assertRaisesRegex(prepare.PreparationError, 'Allow Photos access'):
                prepare.prepare_one('/library', 'id', '/unused')
        photos.PHAsset.fetchAssetsWithLocalIdentifiers_options_.assert_not_called()


class HttpContractTests(unittest.TestCase):
    def test_endpoints_are_authenticated_and_health_advertises_support(self):
        import importlib.util
        from http.client import HTTPConnection
        from http.server import ThreadingHTTPServer
        from unittest.mock import MagicMock
        source = Path(__file__).resolve().parents[2] / 'src' / 'entry.py'
        with tempfile.TemporaryDirectory() as tmp, patch.dict('os.environ', {
            'MEMORYLANE_PLUGIN_PORT': '0', 'MEMORYLANE_PLUGIN_TOKEN': 'secret',
            'MEMORYLANE_PLUGIN_DATA_DIR': tmp, 'MEMORYLANE_PLUGIN_ID': 'photos',
            'MEMORYLANE_PLUGIN_VERSION': '1', 'MEMORYLANE_PLUGIN_API': '1',
        }):
            spec = importlib.util.spec_from_file_location('test_photos_entry', source)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            module.preparation = MagicMock()
            module.preparation.prepare.return_value = {'jpeg_base64': 'image'}
            server = ThreadingHTTPServer(('127.0.0.1', 0), module.Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            conn = HTTPConnection('127.0.0.1', server.server_port, timeout=3)
            try:
                for endpoint in ('/prepare', '/prepare/cancel'):
                    conn.request('POST', endpoint, '{}')
                    response = conn.getresponse()
                    self.assertEqual(response.status, 401)
                    response.read()
                module.preparation.prepare.assert_not_called()
                module.preparation.cancel.assert_not_called()
                headers = {'Authorization': 'Bearer secret'}
                conn.request('GET', '/health', headers=headers)
                response = conn.getresponse()
                import json
                self.assertEqual(json.loads(response.read())['preparation']['version'], 1)
                conn.request('POST', '/prepare', json.dumps({'job_id': 'job', 'uuid': 'id', 'library_path': '/library'}), headers)
                response = conn.getresponse()
                self.assertEqual(json.loads(response.read()), {'jpeg_base64': 'image'})
                module.preparation.prepare.assert_called_once_with('job', '/library', 'id')
                conn.request('POST', '/prepare/cancel', json.dumps({'job_id': 'job'}), headers)
                response = conn.getresponse()
                self.assertEqual(response.status, 200)
                response.read()
                module.preparation.cancel.assert_called_once_with('job')
            finally:
                conn.close()
                server.shutdown()
                server.server_close()
                thread.join()
