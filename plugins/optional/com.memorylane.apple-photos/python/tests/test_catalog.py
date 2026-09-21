import json
import tempfile
import unittest
from pathlib import Path

from memorylane_photos.catalog import map_photo, validate_library


class FakePhoto:
    uuid = "A-UUID"
    original_filename = "Vacation.JPG"
    path = None
    path_derivatives = ["/tmp/preview.jpeg"]
    date = None
    title = "Vacation"
    description = ""
    keywords = ["travel"]
    favorite = True
    hidden = False
    intrash = False
    latitude = 12.5
    longitude = -70.0
    face_info = []


class CatalogTests(unittest.TestCase):
    def test_catalog_exposes_photos_screenshot_classification(self):
        class ScreenCapture(FakePhoto):
            screenshot = True

        self.assertTrue(map_photo(ScreenCapture())["screenshot"])
        self.assertFalse(map_photo(FakePhoto())["screenshot"])

    def test_catalog_camera_summary_is_available_when_original_is_missing(self):
        class Exif:
            camera_make = "Canon"
            camera_model = "R5"
            lens_model = "50mm"
            focal_length = 50.0
            aperture = 1.8
            iso = 400
            shutter_speed = 0.01

        class Photo(FakePhoto):
            exif_info = Exif()

        self.assertEqual(map_photo(Photo())["exif"], {"camera_make": "Canon", "camera_model": "R5", "lens_model": "50mm", "focal_length": 50.0, "aperture": 1.8, "iso": 400, "shutter_speed": 0.01})

    def test_face_region_is_top_left_normalized_for_detector_overlap(self):
        class Area:
            x, y, w, h = 0.5, 0.5, 0.2, 0.2

        class Face:
            name = "Maya"
            mwg_rs_area = Area()

        class Photo(FakePhoto):
            face_info = [Face()]

        self.assertEqual(map_photo(Photo())["faces"], [{"name": "Maya", "x": 0.4, "y": 0.4, "w": 0.2, "h": 0.2}])

    def test_mapping_keeps_one_preview_only_asset(self):
        row = map_photo(FakePhoto())
        self.assertEqual(row["uuid"], "A-UUID")
        self.assertEqual(row["original_filename"], "Vacation.JPG")
        self.assertIsNone(row["original_path"])
        self.assertEqual(row["derivative_path"], "/tmp/preview.jpeg")
        self.assertFalse(row["original_available"])
        self.assertEqual(row["keywords"], ["travel"])

    def test_video_does_not_use_a_jpeg_still_as_its_playable_preview(self):
        class Video(FakePhoto):
            original_filename = "Clip.MOV"
            path_derivatives = ["/tmp/still.jpg", "/tmp/preview.mp4"]

        class VideoWithoutMovie(FakePhoto):
            original_filename = "Clip.MOV"
            path_derivatives = ["/tmp/still.jpg"]

        self.assertEqual(map_photo(Video())["derivative_path"], "/tmp/preview.mp4")
        self.assertIsNone(map_photo(VideoWithoutMovie())["derivative_path"])

    def test_rejects_non_package_and_accepts_readable_package(self):
        with tempfile.TemporaryDirectory() as tmp:
            library = Path(tmp) / "Pictures.photoslibrary"
            library.mkdir()
            (library / "database").mkdir()
            (library / "database" / "Photos.sqlite").write_bytes(b"fixture")
            self.assertEqual(validate_library(str(library)), library.resolve())
            with self.assertRaises(ValueError):
                validate_library(str(Path(tmp) / "not-a-library"))

    def test_loopback_service_requires_token_and_caps_page_size(self):
        records = [{"uuid": str(i)} for i in range(3)]
        scratch = tempfile.TemporaryDirectory()
        library = Path(scratch.name) / "a.photoslibrary"
        library.mkdir()
        (library / "database").mkdir()
        (library / "database" / "Photos.sqlite").write_bytes(b"fixture")
        server = make_server("127.0.0.1", 0, "secret", lambda _: records)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            conn = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
            conn.request("POST", "/catalog", json.dumps({"library_path": str(library), "cursor": 0, "limit": 2}), {"Content-Type": "application/json"})
            denied = conn.getresponse()
            self.assertEqual(denied.status, 401)
            denied.read()
            conn.request("POST", "/catalog", json.dumps({"library_path": str(library), "cursor": 0, "limit": 2}), {"Content-Type": "application/json", "X-MemoryLane-Token": "secret"})
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            body = json.loads(response.read())
            self.assertEqual(len(body["assets"]), 2)
            self.assertEqual(body["next_cursor"], 2)
        finally:
            conn.close()
            server.shutdown()
            server.server_close()
            thread.join()
            scratch.cleanup()

    def test_health_reports_missing_osxphotos_dependency(self):
        server = make_server("127.0.0.1", 0, "secret", lambda _: [])
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            conn = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
            with patch("memorylane_photos.server.importlib.util.find_spec", return_value=None):
                conn.request("GET", "/health", headers={"X-MemoryLane-Token": "secret"})
                response = conn.getresponse()
                self.assertEqual(response.status, 503)
                self.assertIn("osxphotos", response.read().decode())
            conn.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_one_unmappable_photo_does_not_fail_the_page(self):
        class BadPhoto(FakePhoto):
            uuid = "bad"

            @property
            def path(self):
                raise ValueError("bad photo metadata")

        with tempfile.TemporaryDirectory() as tmp:
            library = Path(tmp) / "a.photoslibrary"
            (library / "database").mkdir(parents=True)
            (library / "database" / "Photos.sqlite").write_bytes(b"fixture")
            server = make_server("127.0.0.1", 0, "secret", lambda _: [BadPhoto(), FakePhoto()])
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                conn = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                conn.request("POST", "/catalog", json.dumps({"library_path": str(library), "cursor": 0, "limit": 2}),
                             {"Content-Type": "application/json", "X-MemoryLane-Token": "secret"})
                response = conn.getresponse()
                self.assertEqual(response.status, 200)
                body = json.loads(response.read())
                self.assertEqual([item["uuid"] for item in body["assets"]], ["A-UUID"])
                self.assertEqual(body["failures"][0]["uuid"], "bad")
                conn.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

    def test_catalog_failure_is_logged_without_exposing_details_to_http(self):
        with tempfile.TemporaryDirectory() as tmp:
            library = Path(tmp) / "a.photoslibrary"
            (library / "database").mkdir(parents=True)
            (library / "database" / "Photos.sqlite").write_bytes(b"fixture")

            def broken_loader(_library):
                raise RuntimeError("specific catalog failure")

            server = make_server("127.0.0.1", 0, "secret", broken_loader)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                conn = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                with self.assertLogs("memorylane_photos.server", level="ERROR") as logs:
                    conn.request("POST", "/catalog", json.dumps({"library_path": str(library), "cursor": 0, "limit": 2}),
                                 {"Content-Type": "application/json", "X-MemoryLane-Token": "secret"})
                    response = conn.getresponse()
                    self.assertEqual(response.status, 503)
                    self.assertNotIn("specific catalog failure", response.read().decode())
                self.assertIn("specific catalog failure", "\n".join(logs.output))
                conn.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == "__main__":
    unittest.main()
