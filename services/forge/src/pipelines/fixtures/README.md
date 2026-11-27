`act-v0.2.97.jsonl` contains status records captured on 12 November 2026 from
checksum-verified act v0.2.97 on Linux amd64, executing the image smoke's real
source/Docker/continued-failure/last-step workflow on Forge's internal daemon.
Only `job`, `time`, and `executionTime` were removed to normalize run-specific
values. Setup/completion use lowercase `stepid`; declared steps use `stepID` and
`stage`. Additional synthetic tests cover matrix identities, duplicate names,
composites, pre/post phases, skips and malformed records.
