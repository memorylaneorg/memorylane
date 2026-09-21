"""Read-only translation from osxphotos PhotoInfo to MemoryLane records."""

from pathlib import Path


def validate_library(raw_path: str) -> Path:
    library = Path(raw_path).expanduser().resolve()
    if library.suffix.lower() != ".photoslibrary" or not library.is_dir():
        raise ValueError("Select an existing .photoslibrary package")
    database = library / "database" / "Photos.sqlite"
    if not database.is_file():
        raise ValueError("Photos.sqlite is unavailable; check Photos library permissions")
    with database.open("rb") as source:
        source.read(1)
    return library


def _iso(value):
    return value.isoformat() if value is not None else None


def map_photo(photo) -> dict:
    original = getattr(photo, "path", None)
    derivatives = getattr(photo, "path_derivatives", None) or []
    filename = getattr(photo, "original_filename", None) or getattr(photo, "filename", None)
    is_video = filename and Path(filename).suffix.lower() in {".mov", ".mp4", ".m4v", ".avi", ".mkv"}
    preview_exts = {".mov", ".mp4", ".m4v"} if is_video else {".jpg", ".jpeg", ".heic", ".png"}
    preview = next((p for p in derivatives if Path(p).suffix.lower() in preview_exts), None)
    faces = []
    for face in getattr(photo, "face_info", None) or []:
        area = getattr(face, "mwg_rs_area", None)
        name = getattr(face, "name", None)
        if name and area:
            faces.append({"name": name, "x": area.x - area.w / 2, "y": area.y - area.h / 2, "w": area.w, "h": area.h})
    exif = getattr(photo, "exif_info", None)
    exif_summary = None if exif is None else {
        key: getattr(exif, key, None)
        for key in ("camera_make", "camera_model", "lens_model", "focal_length", "aperture", "iso", "shutter_speed")
    }
    return {
        "uuid": str(photo.uuid),
        "original_filename": filename,
        "original_path": original,
        "derivative_path": preview,
        "original_available": bool(original),
        "date": _iso(getattr(photo, "date", None)),
        "title": getattr(photo, "title", None),
        "description": getattr(photo, "description", None),
        "keywords": list(getattr(photo, "keywords", None) or []),
        "favorite": bool(getattr(photo, "favorite", False)),
        "hidden": bool(getattr(photo, "hidden", False)),
        "in_trash": bool(getattr(photo, "intrash", False)),
        "screenshot": bool(getattr(photo, "screenshot", False)),
        "latitude": getattr(photo, "latitude", None),
        "longitude": getattr(photo, "longitude", None),
        "faces": faces,
        "exif": exif_summary,
    }


def load_catalog(library: Path) -> list:
    # Deliberately imported only after a user enables the plugin and requests sync.
    import osxphotos

    photos_db = osxphotos.PhotosDB(str(library))
    # osxphotos indexes the catalogue once; do not materialize every mapped
    # metadata payload before the first page can be sent.
    return photos_db.photos()
