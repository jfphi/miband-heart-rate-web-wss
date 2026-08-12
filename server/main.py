from __future__ import annotations

import os

import uvicorn


def main() -> None:
    uvicorn.run(
        "server.app.server:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "18080")),
        reload=False,
    )


if __name__ == "__main__":
    main()
