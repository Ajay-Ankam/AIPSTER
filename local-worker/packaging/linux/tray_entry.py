"""Frozen `aipster-tray` entry (Linux). All behavior is the aipster_tray
package plus the Linux runner (tray_main); control/query CLI also lives in
the console launcher (`aipster-worker tray ...`) for visible output."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tray_main import main

if __name__ == "__main__":
    raise SystemExit(main())
