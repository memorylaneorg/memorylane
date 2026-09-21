# Third-party notices

MemoryLane source code is licensed under the MIT License. The packages, native tools, and model files below remain under their own licenses. Exact versions are recorded in `package-lock.json`, `tray-go/go.sum`, and the Python plugin build environment.

## Bundled media tools

| Component | Use | License |
| --- | --- | --- |
| FFmpeg (`ffmpeg-static`) | Video thumbnails and transcoding | GPL-3.0-or-later for the distributed static builds; build configuration determines exact obligations |
| FFprobe (`ffprobe-static`) | Video metadata | FFmpeg project licensing; binary configuration determines LGPL/GPL obligations |
| ExifTool (`exiftool-vendored`) | EXIF and RAW metadata | Perl Artistic License 1.0 or GPL-1.0-or-later |
| Sharp / libvips | Image and RAW preview processing | Apache-2.0 for Sharp; LGPL-3.0-or-later for libvips, with separately licensed codecs |

Release packages must preserve license files supplied by these distributions. Audit FFmpeg and FFprobe after upgrades because enabled codecs and build flags can change the applicable license.

## JavaScript and desktop dependencies

The application directly uses React, React DOM, React Router, Lucide, Fastify, Pino, Zod, dotenv, nanoid, better-sqlite3, argon2, bmp-js, extract-zip, open, p-limit, TypeScript, Vite, Vitest, Tailwind CSS, and related Fastify/build packages. These declare permissive licenses, primarily MIT, ISC, or Apache-2.0. The Go tray uses `gogpu/systray`, `goffi`, `godbus/dbus`, and `golang.org/x/sys` under their declared permissive licenses.

The authoritative license text for every npm and Go module is retained in its installed package/module source. Release automation must retain generated dependency notices in installers.

## Optional Python runtime

AI Runtime directly uses FastAPI, Uvicorn, ONNX Runtime, NumPy, Pillow, Hugging Face Hub, Tokenizers, python-multipart, and certifi. These use permissive licenses including MIT, BSD-3-Clause, Apache-2.0, and MPL-2.0. Apple Photos uses `osxphotos` and its dependency set under their respective licenses. Native plugin builds must include the license report from the resolved environment because transitive dependencies vary by platform.

## Models and weights

| Model | Source | Terms |
| --- | --- | --- |
| Xenova CLIP ViT-B/32 ONNX conversion | `Xenova/clip-vit-base-patch32`, derived from OpenAI CLIP | Model repository and upstream OpenAI CLIP attribution/license |
| YuNet face detector | OpenCV Zoo `face_detection_yunet` | MIT for files in that model directory |
| SFace face recognizer | OpenCV Zoo `face_recognition_sface` | Apache-2.0 repository/model notice; independently review training-data provenance and commercial weight scope before commercial distribution |
| InsightFace `buffalo_l` | InsightFace model zoo | **Non-commercial research use only** unless separately licensed by InsightFace |

Models are downloaded on demand and are not covered by MemoryLane’s MIT License. MemoryLane must present restricted model terms before download and must not silently install `buffalo_l`.

## Artwork and test fixtures

Application artwork is part of MemoryLane unless a file says otherwise. Historical-person image fixtures under the AI runtime tests are public-domain Wikimedia Commons images; their individual sources are recorded in `plugins/optional/com.memorylane.ai-runtime/python/tests/fixtures/SOURCES.md`.

Preserve upstream copyright and license files in source and binary distributions.
