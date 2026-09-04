# Changelog

## [0.13.3](https://github.com/honzapav/portuni/compare/v0.13.2...v0.13.3) (2026-09-04)


### Bug Fixes

* **schema:** keep idx_audit_file_node_ts out of the DDL replay ([66b0eb0](https://github.com/honzapav/portuni/commit/66b0eb0f8cb44a1d8d4d1ba3336480337cf9e3b8))
* **schema:** keep idx_audit_file_node_ts out of the DDL replay ([db420db](https://github.com/honzapav/portuni/commit/db420dbcc959cefdbbdc74dcb32e5af48d3e821a))

## [0.13.2](https://github.com/honzapav/portuni/compare/v0.13.1...v0.13.2) (2026-09-04)


### Bug Fixes

* **web:** keep the API client free of React imports ([9d74421](https://github.com/honzapav/portuni/commit/9d744212ef94063554cc8d9e17a8a3c0757622a9))


### Performance Improvements

* **desktop:** share one reqwest client across the proxy paths ([9f481e0](https://github.com/honzapav/portuni/commit/9f481e02084b54e486e0ee5822639de85aa5c001))
* **mcp:** drop the per-mirror existence query from get_context ([cdfb61e](https://github.com/honzapav/portuni/commit/cdfb61e666c62ded48cf7ae830db366b8065eed8))
* **mcp:** stop re-reading the same node row on the guarded read path ([bc83f78](https://github.com/honzapav/portuni/commit/bc83f7854c12e6474f7b48a36bc3383f2e61e81b))
* measured wins across server, sync, desktop and web ([970ab8c](https://github.com/honzapav/portuni/commit/970ab8c41f60be42e93d5ad8dfaa5d63102328e5))
* **server:** load node detail in two query waves instead of eight ([8c84b64](https://github.com/honzapav/portuni/commit/8c84b649498680712e921316070f0551671861e9))
* **server:** take a schema-version fast path on warm boot ([29eb2f6](https://github.com/honzapav/portuni/commit/29eb2f67275deb686c1a1ebca8fe1e8fd9b8a890))
* stop repeating work that cannot change the answer ([7c956de](https://github.com/honzapav/portuni/commit/7c956dea841867cc7feea7c2b446804850a01c45))
* **sync:** batch file_state and remote_stat lookups in statusScan ([9914031](https://github.com/honzapav/portuni/commit/9914031b63a8d9835cdc158befbd711f4eee36a8))
* **sync:** index the node id every tombstone lookup filters on ([b787705](https://github.com/honzapav/portuni/commit/b78770570b82c202c2b1bc81efc0cff1f27cb6ac))
* **sync:** list the remote once per node instead of stat-ing every file ([a4593dd](https://github.com/honzapav/portuni/commit/a4593dd787b55120f268ba20135cb71bb485a005))
* **sync:** make POST /sync/info-batch set-based instead of a 5N loop ([59ebfe1](https://github.com/honzapav/portuni/commit/59ebfe1c33cbc71e209ceec63e90693148f4568f))
* **web:** lazy-load the terminal, editor and markdown stacks ([d82a4ae](https://github.com/honzapav/portuni/commit/d82a4ae16ee62a1a8111588e09be922001ab00a5))
* **web:** self-host Inter and drop the Google Fonts link ([d66bbba](https://github.com/honzapav/portuni/commit/d66bbba3f65fdb407fd71a1d34be9c400c93c21a))

## [0.13.1](https://github.com/honzapav/portuni/compare/v0.13.0...v0.13.1) (2026-09-03)


### Bug Fixes

* **desktop:** copy to clipboard through a native command ([203e90c](https://github.com/honzapav/portuni/commit/203e90c23ccab7e1f437ff5780b715ebe1cd59d2))

## [0.13.0](https://github.com/honzapav/portuni/compare/v0.12.0...v0.13.0) (2026-09-03)


### Features

* **desktop:** hand the node context to Showtime (handoff code, deep link) ([eac5ef5](https://github.com/honzapav/portuni/commit/eac5ef5574950517499d7e3a2e0ef6ccb2ed9ea0))
* **desktop:** hand the node context to Showtime (handoff code, deep link) ([138692e](https://github.com/honzapav/portuni/commit/138692ef12776bf2ed6f0a76870a6c773306a320)), closes [#237](https://github.com/honzapav/portuni/issues/237)
* **desktop:** multi-window phases 0-2 (terminal correlation, Cmd+Q fix, window identity, per-window routing, config lock, restore, switcher) ([16586ba](https://github.com/honzapav/portuni/commit/16586ba115876bfc8b464a4e33009bff441c9ef0))
* **web:** preview Showtime decks from the bundled preview.html ([d599216](https://github.com/honzapav/portuni/commit/d599216fd6897e384fa7e53b4e03f5d4f6b9830e))
* **web:** preview Showtime decks from the bundled preview.html ([c900c48](https://github.com/honzapav/portuni/commit/c900c489816c59fbac889cbb34067f1366e3363f))


### Bug Fixes

* **scope:** round 4 REST write-gate follow-ups ([#212](https://github.com/honzapav/portuni/issues/212), [#213](https://github.com/honzapav/portuni/issues/213)) ([9343004](https://github.com/honzapav/portuni/commit/9343004a069415201a5cbfea44470834b7b67325))
* **web:** read the window label without importing @tauri-apps/api ([f59b8dc](https://github.com/honzapav/portuni/commit/f59b8dce734c106e43a3e9e5b49bfbb171e104e9))

## [0.12.0](https://github.com/honzapav/portuni/compare/v0.11.0...v0.12.0) (2026-09-02)


### Features

* **scope:** scope model v2, persistent sessions, spawn UX, overview ([88c6efe](https://github.com/honzapav/portuni/commit/88c6efe47b173d6cd2cd70f40deca84ae347607f))


### Bug Fixes

* **mcp:** access checks for unguarded write tools ([5f99b00](https://github.com/honzapav/portuni/commit/5f99b009005e97a2a84f9ede0499b08f67f76741))

## [0.11.0](https://github.com/honzapav/portuni/compare/v0.10.0...v0.11.0) (2026-08-31)


### Features

* **auth:** oauth connectors for chat clients ([25ebf43](https://github.com/honzapav/portuni/commit/25ebf4354a62a3cb2aa03dd445e766f3b7129e0e))

## [0.10.0](https://github.com/honzapav/portuni/compare/v0.9.0...v0.10.0) (2026-08-31)


### Features

* **web:** create the local mirror from the node detail ([728dab2](https://github.com/honzapav/portuni/commit/728dab2a23d1f66336beb0366c9f4cbcf2f720a2))
* **web:** mirror from the node header, folder state, terminal scrolling, recent-nodes picker ([d3866ff](https://github.com/honzapav/portuni/commit/d3866ff12aadcd532a1a660a875560b9efbdf4fb))


### Bug Fixes

* **sandcastle:** per-project tmux socket, verify server tokens match the Keychain ([5aa55d4](https://github.com/honzapav/portuni/commit/5aa55d4908f9ba6a83b0291f110bda1840b74940))
* **sandcastle:** per-project tmux socket, verify server tokens match the Keychain ([f11792d](https://github.com/honzapav/portuni/commit/f11792d99e31a5bb1be69c48142464c5c20693a2))
* **sandcastle:** read the tokens from the Keychain inside the tmux command ([62f5f05](https://github.com/honzapav/portuni/commit/62f5f054d69bd687541683af213e883714de134d))
* **sandcastle:** read the tokens from the Keychain inside the tmux command ([92d4612](https://github.com/honzapav/portuni/commit/92d46120bad4e87ddf0e793467b99813ccc4cceb))
* **sandcastle:** tracking issues order the backlog, never bound it ([088c355](https://github.com/honzapav/portuni/commit/088c35564282315fc317989c504853af4d01f218))
* **sandcastle:** tracking issues order the backlog, never bound it ([781b9fb](https://github.com/honzapav/portuni/commit/781b9fbb0060c25fec6755fd77fd6bd9940a3454))

## [0.9.0](https://github.com/honzapav/portuni/compare/v0.8.0...v0.9.0) (2026-08-30)


### ⚠ BREAKING CHANGES

* **auth:** everyday editing is write, placement is manage, infrastructure is admin

### Features

* **auth:** everyday editing is write, placement is manage, infrastructure is admin ([a269fbe](https://github.com/honzapav/portuni/commit/a269fbeaab434503e830797eb6689347f641913d))
* **auth:** in-app access requests for request-mode nodes ([bff35e6](https://github.com/honzapav/portuni/commit/bff35e68a4f0fe8b330c1727ba4b7ef38233fd96))
* **mcp:** Drive-direct portuni_read_file fallback and portuni_search_files ([927d65c](https://github.com/honzapav/portuni/commit/927d65cdffbac8d285c17f0098a39b6cd9baa41f))
* **web:** download-folder action and local front door in MCP settings ([6645270](https://github.com/honzapav/portuni/commit/6645270a3d5c9b5bb48227944b6a9e18f257edfe))
* **web:** show the download-folder action on nodes without a local mirror ([b7a3695](https://github.com/honzapav/portuni/commit/b7a369525021a1af950f74b4635897b4027c3dbe))


### Bug Fixes

* **desktop:** get_mcp_token hands out the local front-door token in central mode too ([e491600](https://github.com/honzapav/portuni/commit/e491600d52a513abd1b51a37f0d2751a2ad6c4b0))
* **release:** gate the rollout on promoting the pre-release ([#147](https://github.com/honzapav/portuni/issues/147)) ([f3514cd](https://github.com/honzapav/portuni/commit/f3514cdbe82c334b0fdc10325ea790cb9377e7d9))
* **sync:** make portuni_snapshot work without a local mirror ([71539e7](https://github.com/honzapav/portuni/commit/71539e73b1e49bcc9105d82b183725a1d43bbb93))
* **web:** add macOS download link and fix collapsed space on portuni.com ([bccc302](https://github.com/honzapav/portuni/commit/bccc302ba51c7177c2e6318e5d42f4f20e2b936e))
* **web:** silence the pre-login sync banner by catching LocalOnlyError by instance ([5540d29](https://github.com/honzapav/portuni/commit/5540d290836737fafa8637a2613fa078439b62d7))

## [0.8.0](https://github.com/honzapav/portuni/compare/v0.7.0...v0.8.0) (2026-08-29)


### Features

* **api:** resolve endpoint for conflicts and locally deleted files ([fa1f56f](https://github.com/honzapav/portuni/commit/fa1f56fd68391680706c8cbaeaeaffa9492e016d))
* **auth:** let any authenticated user create nodes ([f952df8](https://github.com/honzapav/portuni/commit/f952df83b1c236dd45f09c98f3a504f06f194a6b))
* **desktop:** auto-update ([#144](https://github.com/honzapav/portuni/issues/144)) ([c67203d](https://github.com/honzapav/portuni/commit/c67203d86ff117a9e6cb5a1b82e5cf1069dcf28d))
* **sync:** central remote-sweep endpoint, agent sync run calls it first ([597a36f](https://github.com/honzapav/portuni/commit/597a36fc6afaa670fc965b83302825b4da08a59c))
* **sync:** file mutations are pending ops, retried by the sync run until complete ([e51f342](https://github.com/honzapav/portuni/commit/e51f342bb9f163b13184936166b98d869c9232ac))
* **sync:** moves and renames leave tombstones so stale copies are cleaned up, not pushed back ([f54cdaf](https://github.com/honzapav/portuni/commit/f54cdaf7730e09390ba1225be4410b11ca9c94d1))
* **sync:** remote sweep reconciles deletions and new files on the remote ([a24e574](https://github.com/honzapav/portuni/commit/a24e57470c5c1edd3ee476e4cc35e8fbdd055f3d))
* **sync:** replace the orphan class with pull / remote_missing / remote_error ([ad2831e](https://github.com/honzapav/portuni/commit/ad2831e8ba3dd619f0e266a574c2508464cb9129))
* **sync:** sync run sweeps the remote before scanning ([2fca122](https://github.com/honzapav/portuni/commit/2fca1226fb191aff1479b50a4b82a8a49610a050))
* **web:** disable create-node buttons below the required scope ([368c357](https://github.com/honzapav/portuni/commit/368c3573bd90b11ca30e72a1451594271d72e158))
* **web:** resolve buttons for conflicts and locally deleted files ([65f4212](https://github.com/honzapav/portuni/commit/65f4212dba62c7833c12d64ca854a95be7631855))


### Bug Fixes

* **api:** 409 for an impossible keep_local; correct sweep adoption depth in docs ([90f1d53](https://github.com/honzapav/portuni/commit/90f1d53894af98739c629cf4546d1ee2361aa6d3))
* **api:** close resolve endpoint IDOR, map dirty-pull to 409, fix hash refresh at the source ([e0d4047](https://github.com/honzapav/portuni/commit/e0d4047ff9740f17b52faae8cbd1568cc3bfca9a))
* **mcp:** report the device's local step for proxied moves ([b8cd75e](https://github.com/honzapav/portuni/commit/b8cd75e5e471ad5a6b0aee9c261c36d53bdecc07))
* **sandcastle:** check the global tmux environment, not the session one ([#143](https://github.com/honzapav/portuni/issues/143)) ([12dbee9](https://github.com/honzapav/portuni/commit/12dbee9e069d6b36b709ead55f38870a3183e5a2))
* **sandcastle:** homebrew on PATH for ssh sessions (tmux, docker) ([#139](https://github.com/honzapav/portuni/issues/139)) ([8ffd7b3](https://github.com/honzapav/portuni/commit/8ffd7b395c7abfd5d1110c60dcf0eebe02a9e7b4))
* **sandcastle:** start the loop on its own tmux socket ([#142](https://github.com/honzapav/portuni/issues/142)) ([a069a63](https://github.com/honzapav/portuni/commit/a069a63fb33df2f3bc7f2e6850be18f179847a04))
* **sandcastle:** tell the agent to run commands in the foreground ([#145](https://github.com/honzapav/portuni/issues/145)) ([75e513f](https://github.com/honzapav/portuni/commit/75e513fea5bf087c63a465b0e4f3f69c51df38bb))
* **sync:** a pending delete verifies the target object before removing it ([453c0a1](https://github.com/honzapav/portuni/commit/453c0a139bca0bf76484dd3b5d11e8109daf2f8e))
* **sync:** a rejected central sweep no longer kills the teammate sync run ([eefcc88](https://github.com/honzapav/portuni/commit/eefcc8876ba3142f5a3b74e3a9d74cdf0dddd22e))
* **sync:** bound tombstone lookups by candidate set / time, not row count ([6d6e6a4](https://github.com/honzapav/portuni/commit/6d6e6a4bb97d1d584a42f1c8c70674144d7cd775))
* **sync:** dedupe moveFile tombstone detail, correct stale doc comments ([b5eda45](https://github.com/honzapav/portuni/commit/b5eda458a36eba96e450b6243cc6f5027d8c67ab))
* **sync:** Drive stat honours trash and revalidates the path cache ([0b184ad](https://github.com/honzapav/portuni/commit/0b184ada51b00da423aa8ce39f728844d17cf8bb))
* **sync:** guard pending-op retry against stale/ambiguous record state ([08dcc42](https://github.com/honzapav/portuni/commit/08dcc42af56297e6cf7007a80e3188080dd4b6fc))
* **sync:** one Drive folder per path, move from the file's real parents ([ae8926f](https://github.com/honzapav/portuni/commit/ae8926f7494b4a73105419f751cab75fe7168c6c))
* **sync:** OpenDAL stat distinguishes NotFound from a failure ([6c05698](https://github.com/honzapav/portuni/commit/6c056985beaab42f0bc498bee7c6486aadb4ab9a))
* **sync:** skip hash backfill for native-format adopted remote files ([24f7547](https://github.com/honzapav/portuni/commit/24f7547d1c23e5ffba5350967ec9e37273574181))
* **sync:** sweep lists only the three sections; central tombstones dedupe per (path, file) ([fe0fad0](https://github.com/honzapav/portuni/commit/fe0fad02dfd3cb54211c45215f22a421f674c9cd))


### Performance Improvements

* **auth:** resolve node ACL chains in one batched query ([ab12da4](https://github.com/honzapav/portuni/commit/ab12da463c687448e096c90cc9eff1b394eccb2b))

## [0.7.0](https://github.com/honzapav/portuni/compare/v0.6.0...v0.7.0) (2026-07-20)


### Features

* **web:** autosave the sharing tab ([e1b1f47](https://github.com/honzapav/portuni/commit/e1b1f47341af0343fd3f4054ecbca968316b3e70))


### Bug Fixes

* **api:** write ISO updated_at when saving node access ([9f65abe](https://github.com/honzapav/portuni/commit/9f65abe338dd1c0e620d0ad8bb1999e5127e4e42))

## [0.6.0](https://github.com/honzapav/portuni/compare/v0.5.0...v0.6.0) (2026-07-19)


### Features

* **auth:** public /auth/desktop-config endpoint serving the desktop OAuth client ([2be1f8f](https://github.com/honzapav/portuni/commit/2be1f8fbf807e2cace9047fd3680df5d38890e31))
* **desktop:** setup_central command — join a central server from just its URL ([2cd8c0c](https://github.com/honzapav/portuni/commit/2cd8c0c5829fad104fe0d6daf50c41d5427f5942))
* **web:** onboarding wizard joins a team via server URL instead of Turso credentials ([b389354](https://github.com/honzapav/portuni/commit/b389354b818a7fd17a1d59b34c08f52b227fb5e1))
* **web:** post-login first-steps screen points to the terminal-creates-mirror flow ([3bf0250](https://github.com/honzapav/portuni/commit/3bf02504fc41020658484e22d9f97379191407c6))


### Bug Fixes

* **desktop:** bound setup_central fetch with a 15 s timeout ([33deb8c](https://github.com/honzapav/portuni/commit/33deb8cba47a2496af511f09ccfc5095410a69b3))
* **desktop:** route Cmd+Q through the unsynced-files quit guard ([80b6c51](https://github.com/honzapav/portuni/commit/80b6c516bfe264dfdf8d638827959fac17589cda))

## [0.5.0](https://github.com/honzapav/portuni/compare/v0.4.0...v0.5.0) (2026-07-19)


### Features

* **sync:** expose per-node delete tombstones in sync-info ([fb3a00e](https://github.com/honzapav/portuni/commit/fb3a00e53029399934b4412368af856a9728f661))
* **sync:** propagate on-disk moves and deletions in central mode ([0b4b768](https://github.com/honzapav/portuni/commit/0b4b7683acad46fefb4d754ebf5a00240c7f2db5))
* **sync:** tombstone reconciliation stops deleted files resurrecting (GH [#79](https://github.com/honzapav/portuni/issues/79)) ([1ef3f09](https://github.com/honzapav/portuni/commit/1ef3f090f6ae90e313d66051dd211838ac4f0881))


### Bug Fixes

* **desktop:** route /sync/pending to the local sync agent in central mode ([8e6a176](https://github.com/honzapav/portuni/commit/8e6a17669df2882a04b8b3c02c7ff00e70a503cc))
* **desktop:** ship portuni-guard.sh in the app bundle so tier-3 hooks materialize ([e7bf132](https://github.com/honzapav/portuni/commit/e7bf1321c77ee3f945951549d47e324cd8baa205))
* **scope:** point the soft hint at real neighbour paths, not retired staging ([f95b04b](https://github.com/honzapav/portuni/commit/f95b04b368141dedf174c2b292c922beb5afc81c))
* **sync:** apply the local disk step after proxied delete/move/rename in agent mode ([46003bc](https://github.com/honzapav/portuni/commit/46003bcbfdaf119de06f3e0a7f1a0c7dfd0bbe83)), closes [#78](https://github.com/honzapav/portuni/issues/78)
* **sync:** complete delete/move/rename propagation between disk and record ([c1c3473](https://github.com/honzapav/portuni/commit/c1c3473f56014168e2092e6c0bf911ee4ceff878))
* **sync:** detect on-disk moves by inode in the watcher instead of the dead move phase ([8aef4c1](https://github.com/honzapav/portuni/commit/8aef4c1c9af70c1c302e775ada16b8ecd3ee5c6c))
* **sync:** keep the event loop alive in hung-request timeout tests ([b6f50be](https://github.com/honzapav/portuni/commit/b6f50bec4f0d4a163026a93484aa0e399bb04b5c))
* **sync:** review fixes — hash-algorithm-aware tombstone match, rename_folder gate, UI cleanup line ([f20ad78](https://github.com/honzapav/portuni/commit/f20ad784b31deb75ef99c418b76ab027928f8de5))
* **sync:** stop losing watcher registrations on hung central requests ([15b1088](https://github.com/honzapav/portuni/commit/15b10881976ab9487c1c0d7e3aa4b6780ab22580)), closes [#80](https://github.com/honzapav/portuni/issues/80)
* **sync:** watch and backfill mirrors registered after the watcher starts ([17b5610](https://github.com/honzapav/portuni/commit/17b561031b7d0f5294dbc3e980ea685d778aedc9))
* **web:** float the file-changed banner over the editor so it cannot be missed ([2de2eb8](https://github.com/honzapav/portuni/commit/2de2eb8fa6a21c3663c302a061ceace6004cca6a))

## [0.4.0](https://github.com/honzapav/portuni/compare/v0.3.0...v0.4.0) (2026-07-10)


### Features

* **web:** enable terminals in central mode (drop stale Phase B gate) ([e2e494a](https://github.com/honzapav/portuni/commit/e2e494aebdbd323c53e8e775d526c39e9882fa49))


### Bug Fixes

* **sync:** agent-mode portuni_store copies in outside sources and routes by status ([6f9b77f](https://github.com/honzapav/portuni/commit/6f9b77f8b68bb9d7fd25845fbb61271fe0396ee4))
* **sync:** serve file content from the device mirror in central mode ([5dada5d](https://github.com/honzapav/portuni/commit/5dada5dc00e34d602caea8be7e252b1fb29c2a04))
* **web:** drop the 'fáze B' jargon from the local-only error message ([ac19009](https://github.com/honzapav/portuni/commit/ac1900920263696f2e68907a5f7bdff64177f5a1))
* **web:** hydrate local_mirror in the node-detail poll too (central mode) ([ec7f89e](https://github.com/honzapav/portuni/commit/ec7f89efe5be6e3761a621a60b9240f466e3d0ae))
* **web:** OpenCode preset opens the interactive TUI ([0e83f76](https://github.com/honzapav/portuni/commit/0e83f769ab73a6ff3618bc2ac61a1298c5976519))
* **web:** overlay local_mirror in fetchNode itself (all detail paths) ([c7b7890](https://github.com/honzapav/portuni/commit/c7b7890b62671619d4b70f4d51128da896a9ffd2))

## [0.3.0](https://github.com/honzapav/portuni/compare/v0.2.0...v0.3.0) (2026-07-06)


### Features

* **scope:** add portuni_read_file content tool for ad-hoc nodes ([3bf9a12](https://github.com/honzapav/portuni/commit/3bf9a1253ade14c6bd1cccf9bf36e89394ab432f))
* **scope:** grant depth-1 neighbour real mirrors in central mode ([c8317f0](https://github.com/honzapav/portuni/commit/c8317f0c1e879525d2af4e7b5e4532ce53eaea91))
* **scope:** grant depth-1 neighbour real mirrors in the sandbox profile ([d8f5ef1](https://github.com/honzapav/portuni/commit/d8f5ef13ab2e3cd3217efd702d61767ca0b1d3b6))
* **scope:** return real neighbour paths from central-mode read tools ([89dc287](https://github.com/honzapav/portuni/commit/89dc287d087421b735e9f42294accfe595a30253))
* **scope:** seatbelt can grant read on in-scope real mirror roots ([3feb246](https://github.com/honzapav/portuni/commit/3feb246d5f613e88ec7d91ddbb902d00bcb8cece))
* **scope:** serve real mirror paths for the spawn set, skip staging them ([ab05c8d](https://github.com/honzapav/portuni/commit/ab05c8d8a21c8d16f4841301e28d9e5e20dd07ab))


### Bug Fixes

* **mcp:** derive home-node file local_paths in central-mode get_node ([488ddfc](https://github.com/honzapav/portuni/commit/488ddfcac7af2e2296c47360bedcfe9dac24f469))
* **mcp:** fill home-node local_path in central-mode get_context ([8ddb44a](https://github.com/honzapav/portuni/commit/8ddb44a4d6123c456808fc038c5f78c57367bb33))
* **scope:** sweep stale ad-hoc staged copies once per session ([6121bd9](https://github.com/honzapav/portuni/commit/6121bd93d4d817b4616554eda6bfe453087d3d6b))
* **security:** enforce scope on central-mode portuni_read_file ([3246878](https://github.com/honzapav/portuni/commit/3246878d3cd5cb4a0f4fcb7c2adaa97ba7f051bd))
* **sync:** overlay device local_mirror on node reads in central mode ([3edaca6](https://github.com/honzapav/portuni/commit/3edaca604d2b5113bf7852d1baca8a0a8854ae5c))
* **web:** disable 'Všichni' on inherited-restricted nodes; type NodeAccessResponse.visibility ([847acc3](https://github.com/honzapav/portuni/commit/847acc3531a8ad02185a9624f97864cb92ed16b7))
* **web:** overlay device local_mirror in central-mode node detail ([61f236c](https://github.com/honzapav/portuni/commit/61f236c4e40c5bb04a33d94b2330d4049e47bfdf))
* **web:** recover file relative paths in central mode from sync-status ([89c8ba5](https://github.com/honzapav/portuni/commit/89c8ba5c39c911ff697ba79ba525fda1f1b74db3))

## [0.2.0](https://github.com/honzapav/portuni/compare/v0.1.0...v0.2.0) (2026-07-05)


### Features

* **access:** PUT /nodes/:id/access owns visibility+entries+mode atomically ([56c2c98](https://github.com/honzapav/portuni/commit/56c2c98a04c3ef919a9507eca31da1e6c51f2bfe))
* **agent:** device-local MCP tool handlers over engine-central ([a307908](https://github.com/honzapav/portuni/commit/a307908e746a6f76c5e3c48585ed5a815beaa62d))
* **agent:** e2e MCP leg + data-modes docs for the local front door ([f19a25c](https://github.com/honzapav/portuni/commit/f19a25c475fe1cc593bbd3f97a323fb52aa30128))
* **agent:** MCP front door — local tools intercepted, rest proxied to central ([f61b1e3](https://github.com/honzapav/portuni/commit/f61b1e39f0dfd9190e881b9abce795971a2beeb3))
* **agent:** mount MCP front door on the agent sidecar ([b44b596](https://github.com/honzapav/portuni/commit/b44b596945ab4656f4d10454c7b1ed207757c4e8))
* **agent:** per-mirror MCP configs target the local front door in agent mode ([a48c2a4](https://github.com/honzapav/portuni/commit/a48c2a4bfb0444273c79c380ffd21553fd981cf4))
* **api:** /sync/drive/* REST endpoints for Drive connect flow ([b407cfb](https://github.com/honzapav/portuni/commit/b407cfb20fd96af095220f94b974f98340209ce2))
* **desktop:** google_drive_connect command — OAuth with Drive scope, token straight to sidecar ([f30f0f3](https://github.com/honzapav/portuni/commit/f30f0f3b617619dc86136425b5b9b74055be2223))
* **mcp:** self-guiding routing errors + setup-drive-remote prompt ([35f996c](https://github.com/honzapav/portuni/commit/35f996cb3ad33673a2661f9ddce4f3bc0026965f))
* **sync:** domain remote-service with Drive connect/target/status/test/disconnect ([9c0b210](https://github.com/honzapav/portuni/commit/9c0b210ff1f407bb044cf5dd13dabfa3c64c799f))
* **sync:** drive adapter supports user OAuth refresh-token mode ([d4b7c9b](https://github.com/honzapav/portuni/commit/d4b7c9b844784a4399da8df7e9e4a4f10e81b7e3))
* **sync:** refresh-token auth module for Drive user OAuth ([fdcb344](https://github.com/honzapav/portuni/commit/fdcb344e39d1476ec4208d099c6f2ffea868089f))
* **sync:** relax Drive config for user OAuth, extend DeviceToken ([115c78a](https://github.com/honzapav/portuni/commit/115c78aec30a851331c365f2886a690294292d73))
* **web:** local-only banner in node files pane when Drive is not connected ([71d326b](https://github.com/honzapav/portuni/commit/71d326ba863b424cb4350afadf4174aa049cd9a9))
* **web:** Nastavení → Synchronizace — Drive connect UI ([9a4e7a5](https://github.com/honzapav/portuni/commit/9a4e7a5982c22fbef5838f0dc762d233838460fb))
* **web:** unified Sdílení tab — 3-mode access selector, drop header visibility dropdown ([215f2da](https://github.com/honzapav/portuni/commit/215f2da8985f1dd1bfea7a473a14aaef53e5bc56))


### Bug Fixes

* **access:** enforce visibility=private on the graph (creator + admins only) ([e2ef53f](https://github.com/honzapav/portuni/commit/e2ef53fcb8a67fc9f427b593b6f123ca8a5b178e))
* **agent:** close orphaned upstream client on uninitialized sessions; test home_node_id forwarding ([a1ec759](https://github.com/honzapav/portuni/commit/a1ec759a4812f8e1d6146f01059f09bb097a089b))
* **agent:** honor include_discovery, fail loudly on unsupported store args, note ignored adopt paths ([23d1ced](https://github.com/honzapav/portuni/commit/23d1ced29c6dd68ebbf14b0504e3e41628161863))
* **api:** /sync/drive/target returns 409 not_connected consistent with targets ([0eeb446](https://github.com/honzapav/portuni/commit/0eeb446e5f9426efa6387d84d74500a8c8e63dc0))
* **backup:** keep Turso token out of argv (curl -H @- via stdin) ([0b268dd](https://github.com/honzapav/portuni/commit/0b268dd513ea6ff1251be12164d61e4931698c33))
* **desktop:** agent-mode terminals carry the local MCP token ([3113063](https://github.com/honzapav/portuni/commit/3113063f6c3e46cc0d69e206bb36367bbfe35e8c))
* **desktop:** global MCP config targets local front door in central mode ([bd7bd13](https://github.com/honzapav/portuni/commit/bd7bd13eff27711d1172fcb26d64e15b22074162))
* **docs,e2e:** correct proxied-mutation gap description; harden MCP SSE parsing ([8040ad5](https://github.com/honzapav/portuni/commit/8040ad525d3553801053d174978b46e58259caf0))
* **mcp:** device-local hint when workspace root is missing ([05cda99](https://github.com/honzapav/portuni/commit/05cda99df2f8a77b6ce08f637223cf6af919158f))
* **mcp:** drop stale owner_id constraint from update_node descriptions ([64d3a95](https://github.com/honzapav/portuni/commit/64d3a9512865524785a00060bf5f7ba485a4c645))
* **scope:** align agent-scope private hard-floor to created_by ([6cb2a5a](https://github.com/honzapav/portuni/commit/6cb2a5af7ec246a2e0bc0bd396f26a7cce1082b4))
* **sync:** min-scopes for /sync/drive/*, varlock refresh-token mode, banner on empty nodes ([76274fc](https://github.com/honzapav/portuni/commit/76274fc2f0f4e2381cf8fc5ad15758e3ed19e4c0))
* **sync:** report unrouted Drive state, fail-fast SA My-Drive config, guard SA/gdrive name collision ([b3fb845](https://github.com/honzapav/portuni/commit/b3fb8458709032ec7f306830d29282f8987d459e))
* **web:** inline disconnect confirm (window.confirm is a Tauri no-op); surface backend error detail ([64de904](https://github.com/honzapav/portuni/commit/64de904d5dea5b3011c895fb2669eb0bd61bfef0))
* **web:** label the open sharing mode 'Všichni' not 'Tým' ([bfa1df1](https://github.com/honzapav/portuni/commit/bfa1df154ed59b99c0c32c272100dbff7fb11e15))
