# AI architecture

AI is optional and split into three installable plugins:

- **AI Runtime** is a supervised local service for CLIP embeddings, face inference, and vector storage.
- **AI Search & Similar** connects semantic and image-similarity features to the runtime.
- **People** adds face detection, grouping, review, and naming.

The server sends decoded thumbnails or text over an authenticated loopback connection. The runtime does not receive original filesystem paths. Core retains the analysis queue and shared metadata, so work resumes after restarts and uninstalling an AI plugin does not affect the original library.

The default embedding model is `Xenova/clip-vit-base-patch32`. The default face pipeline uses OpenCV Zoo YuNet and SFace models. Users may explicitly select the InsightFace `buffalo_l` option, whose pretrained model files carry non-commercial research restrictions; the application must show those terms before download. See [Third-party notices](../../THIRD_PARTY_NOTICES.md).

During source development, `npm run ai` prepares a private virtual environment beneath the plugin and starts the same service entry point used in packaged artifacts. Packaged users install a self-contained platform artifact and do not need Python.
