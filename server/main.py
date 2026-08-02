from __future__ import annotations

import uvicorn


def main() -> None:
    uvicorn.run(
        "server.app.server:app",
        host="0.0.0.0",
        port=18080,
        reload=False,
    )


if __name__ == "__main__":
    main()
