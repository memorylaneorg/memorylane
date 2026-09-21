import uvicorn

from .config import Settings
from .main import app


def main() -> None:
    s = Settings()
    uvicorn.run(app, host=s.host, port=s.port, log_level="info")


if __name__ == "__main__":
    main()
