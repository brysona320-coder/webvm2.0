# Wisp-JS client 0.5.0

The unmodified `wisp-client.mjs` and source map come from the published `@mercuryworkshop/wisp-js@0.5.0` package. Wisp-JS is copyright MercuryWorkshop and contributors, licensed LGPL-3.0-or-later.

- Source package: https://registry.npmjs.org/@mercuryworkshop/wisp-js/-/wisp-js-0.5.0.tgz
- Project: https://github.com/MercuryWorkshop/wisp-js
- Client sources: `wisp-source/src/`, reproduced from the published source map, with the original package entry point.
- Build configuration: `wisp-webpack.config.js` from upstream; copy it to `webpack.config.cjs` when using it in a type-module checkout.
- License: `LICENSE-wisp-LGPL-3.0.txt`, with `LICENSE-GPL-3.0.txt`.

To rebuild or replace the module, unpack the pinned source package, install its dependencies and build the client ES module with upstream's webpack configuration (`webpack --config webpack.config.cjs --config-name client_es6 --mode production`). The published package contains the full source and dependency manifest. Replace `vendor/wisp-client.mjs` with a compatible module exporting `client.ClientConnection`, then rebuild BLACKWIRE. The separate ES module can also be replaced on the deployed host without changing BLACKWIRE's adapter.

No Wisp-JS source changes have been made. BLACKWIRE integrates it through `wisp-network.js` under BLACKWIRE's Apache-2.0 license.
