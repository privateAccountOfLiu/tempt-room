"""Extract a verified Node source archive with Unicode-safe Windows paths."""
import copy
from pathlib import Path, PurePosixPath
import sys
import tarfile

if sys.version_info < (3, 12):
    raise SystemExit("Source extraction requires Python 3.12+ with the data filter")

archive, destination, expected_root = sys.argv[1:]
target = Path(destination).resolve()
if not target.is_dir() or any(target.iterdir()):
    raise SystemExit("Source destination must be a newly created empty directory")

with tarfile.open(archive, "r:gz") as source:
    members = []
    total_bytes = 0
    for member in source:
        path = PurePosixPath(member.name)
        if (
            path.is_absolute()
            or ".." in path.parts
            or not path.parts
            or path.parts[0] != expected_root
            or "\\" in member.name
            or ":" in member.name
            or not (member.isfile() or member.isdir())
        ):
            raise SystemExit("Unsupported or escaping source archive entry")
        if len(path.parts) == 1:
            continue
        total_bytes += member.size
        if len(members) >= 200_000 or total_bytes > 2 * 1024**3:
            raise SystemExit("Source archive exceeded its extraction bound")
        normalized = copy.copy(member)
        normalized.name = "/".join(path.parts[1:])
        members.append(normalized)
    source.extractall(target, members=members, filter="data")
