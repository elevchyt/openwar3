// The 32-bit Linux build's entry: the ordinary shell with Electron 18's gaps filled in front of
// it (./compat.mjs). tools/build-legacy-main.mjs bundles this into `electron/main-legacy.cjs`,
// because Electron 18 cannot load an ES module as its main script (that arrived in Electron 28).
import "./compat.mjs";
import "../main.mjs";
