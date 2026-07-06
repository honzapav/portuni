# Changelog

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
