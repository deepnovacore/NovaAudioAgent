# Release candidate foundation

This directory defines repository-verifiable release inputs. It does not certify a release.

`release-targets-v1.json` is the closed tuple/resource matrix. The build derives the production
dependency report from `package-lock.json`; package inspection owns one private ASAR snapshot for
hashing, listing, and extraction. `verify-release-evidence.mjs` keeps every missing, unsigned, stale,
or cross-artifact gate pending or failed.

The native resource manifest intentionally cannot be generated until the audited project lock/root
addon, Codex sandbox probe, and Windows Job guardian exist for the selected target. The macOS audio
helper and LiveKit package-owned addons alone are insufficient. Current local package output is an
unsigned preview and is not clean-machine, signing, provider, Codex, Camera, audio, hardware, or
publication evidence.

Node is therefore not the released default. The Python source implementation, tests, launchers, and
explicit backend switch remain the rollback oracle until a later evidence-complete release window.
