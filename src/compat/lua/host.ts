import { lua, lauxlib, lualib, to_luastring, to_jsstring, type LuaState } from "fengari";
import type { Interpreter } from "../../jass/interpreter";
import type { HostFunction, Runtime } from "../../jass/runtime";
import { rawcodeToInt } from "../../jass/lexer";
import { asNum, asStr, jBool, jHandle, jInt, jReal, jStr, JNULL, type JassValue } from "../../jass/values";

// Running a map whose triggers are LUA (docs/map-compatibility.md, step 6).
//
// A map saved by a 1.31+ World Editor may ship `war3map.lua` instead of `war3map.j`. The
// language is different; **the API is not**. Every name such a script calls is one of three
// things, and all three already exist in this engine:
//
//   * an engine NATIVE (`CreateUnit`, `TriggerAddAction`) — `Runtime.natives`;
//   * a BJ from the install's own `Scripts\blizzard.j` (`IsUnitAliveBJ`, `ForGroupBJ`,
//     `PolarProjectionBJ`) — a JASS function our interpreter already loaded and can run;
//   * a common.j CONSTANT or a blizzard.j global (`PLAYER_STATE_RESOURCE_GOLD`,
//     `bj_MAX_PLAYERS`) — `Runtime.globals`.
//
// So this is a FRONT END, not a second engine: one Lua state whose globals resolve into the
// running JASS runtime. Test of Faith Reborn calls `IsUnitAliveBJ` 381 times and `ForGroupBJ`
// 139 — the BJ layer is most of what a Lua map is made of, and routing to it is what makes
// this tractable at all.
//
// Five things are the whole of the design:
//
//  1. **Unknown globals resolve into the runtime.** `_G` gets an `__index` that looks up a
//     JASS global first (live, never cached — blizzard.j writes `bj_lastCreatedUnit` on
//     nearly every BJ call and a cached copy would be a lie the second time the script
//     looked) and then a callable, which IS cached back into `_G` so the second call is an
//     ordinary table hit. `__newindex` writes through to a JASS global that already exists,
//     so the two halves never hold two copies of one variable.
//  2. **A handle is light userdata.** The same JS object per handle id, so Lua `==` is the
//     handle identity JASS `==` is, `type()` answers "userdata" as the real client does, and
//     a handle works as a table key. Nothing about the handle table itself changes.
//  3. **A Lua function handed to the engine becomes a named host function.**
//     `TriggerAddAction(t, Foo)` hands us a Lua function; it is registered in
//     `Runtime.hostFunctions` under a name and JASS gets a plain `code` value. Everything
//     downstream — trigger actions, boolexprs, timer handlers, `ForGroup` — is unchanged.
//  4. **A wait is a coroutine yield.** Every call into Lua runs inside a Lua coroutine, and
//     `TriggerSleepAction` / `PolledWait` yield it. The interpreter's thread protocol is a
//     generator yielding SECONDS, so the two nest exactly: `HostFunction.run` resumes the
//     coroutine, yields whatever it asked to sleep, and resumes it when the thread wakes.
//  5. **The map's own globals are published by NAME.** `config`, `main` and every
//     `Trig_*_Actions` become host functions the interpreter can call exactly as it calls a
//     JASS one — which is what makes the map start at all, and what lets blizzard.j's
//     `ExecuteFunc("…")` find a Lua trigger.
//
// **What is NOT supported, and says so:** a wait reached THROUGH a JASS BJ that Lua called.
// The bridge into the interpreter is an ordinary JS call, so Lua cannot yield across it
// ("attempt to yield across a JS-call boundary"), and such a call is abandoned exactly as a
// wait inside a JASS condition is. The two functions that matter — `TriggerSleepAction` and
// `PolledWait` — are intercepted HERE for that reason rather than routed to blizzard.j.
//
// **Safety.** A map is untrusted content the player downloaded. The state opens the standard
// libraries and then takes away every door out of the sandbox — `io`, `os`, `package`,
// `require`, `dofile`, `loadfile`, `load`, `debug` — so a map script can compute and call the
// game API and do nothing else.

/** The floor on a wait: "next tick", never "never". */
const MIN_WAIT = 0;

/** A coroutine that yields this many times without finishing is abandoned. */
const MAX_RESUMES = 100000;

/** The names this host answers ITSELF rather than routing into the runtime (see the note). */
const INTERCEPTED = new Set(["TriggerSleepAction", "PolledWait"]);

/**
 * Globals that exist ONLY in Lua mode, because JASS has syntax for them and Lua has not.
 *
 * `FourCC` is the whole list and it is not optional: a JASS script writes a rawcode as the
 * literal `'hfoo'`, and a Lua one cannot, so every compiled Lua map converts its ids through
 * this instead — Test of Faith Reborn's `main()` calls it on its second line. It is written in
 * JS rather than in the prologue's Lua so it produces the SAME 32-bit value the lexer gives a
 * JASS literal, sign and all: a rawcode whose first byte is >= 0x80 is negative on the engine
 * side, and a Lua-side `>>` would have made it positive and never equal to anything.
 */
const LUA_ONLY = new Set(["FourCC"]);

/** Base-library names a downloaded map has no business reaching. */
const SANDBOX_REMOVE = ["io", "os", "package", "require", "dofile", "loadfile", "load", "loadstring", "collectgarbage", "debug"];

export interface LuaMapScript {
  /** Run the map's chunk and publish its global functions. Throws the Lua error if it will
   *  not compile — the caller decides what a map with a broken script means. */
  load(source: string, chunkName: string): void;
  /** Did the chunk define a global function of this name? (`config`, `main`.) */
  hasFunction(name: string): boolean;
  /** How many of the map's own functions were published (diagnostics). */
  functionCount(): number;
  /** Drop the state and every host function it registered. */
  dispose(): void;
}

/**
 * Put a Lua front end on a running interpreter. The interpreter must already have the
 * install's `common.j`, our compat prelude and `blizzard.j` loaded — that is what the
 * script's BJ calls and its constants resolve into.
 */
export function createLuaMapScript(interp: Interpreter, seed: number): LuaMapScript {
  const rt: Runtime = interp.rt;
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  /** Handle boxes, interned per handle id — see note 2. */
  const handleBoxes = new Map<number, { h: number; ty: string }>();
  const boxOf = (h: number, ty: string): { h: number; ty: string } => {
    let box = handleBoxes.get(h);
    if (!box) { box = { h, ty }; handleBoxes.set(h, box); }
    return box;
  };

  /** Engine names this host has cached into `_G`. They are OURS, not the map's, and must
   *  never be published back as host functions — `IsUnitAliveBJ` registered as a host
   *  function that calls `IsUnitAliveBJ` is an infinite recursion. */
  const cachedEngineNames = new Set<string>();
  /** Names published out of the map's own globals, so `dispose` can take them back. */
  const published = new Set<string>();
  let nextAnonymous = 0;

  // --- values ------------------------------------------------------------------------

  /** Push a JASS value onto `S`. */
  const push = (S: LuaState, v: JassValue): void => {
    switch (v.k) {
      case "int": lua.lua_pushinteger(S, v.n); return;
      case "real": lua.lua_pushnumber(S, v.n); return;
      case "bool": lua.lua_pushboolean(S, v.b); return;
      case "string": lua.lua_pushstring(S, to_luastring(v.s)); return;
      case "handle": lua.lua_pushlightuserdata(S, boxOf(v.h, v.ty)); return;
      // A `code` going this way is a JASS function NAME. A Lua script never receives one in
      // practice (it passes its own functions in), so the readable name is the honest answer.
      case "code": lua.lua_pushstring(S, to_luastring(v.fn)); return;
      default: lua.lua_pushnil(S); return;
    }
  };

  /** One Lua stack slot as a JASS value. */
  const read = (S: LuaState, i: number): JassValue => {
    switch (lua.lua_type(S, i)) {
      case lua.LUA_TBOOLEAN:
        return jBool(lua.lua_toboolean(S, i));
      // Lua 5.3 keeps integers and floats apart, and so does JASS — `7/2` is 3 in one and 3.5
      // in the other. Carrying the distinction across rather than guessing is the whole reason
      // the value model has two numeric kinds (values.ts).
      case lua.LUA_TNUMBER:
        return lua.lua_isinteger(S, i) ? jInt(lua.lua_tointeger(S, i)) : jReal(lua.lua_tonumber(S, i));
      case lua.LUA_TSTRING:
        return jStr(to_jsstring(lua.lua_tostring(S, i)));
      case lua.LUA_TLIGHTUSERDATA: {
        const box = lua.lua_touserdata(S, i) as { h: number; ty: string } | null;
        return box && typeof box.h === "number" ? jHandle(box.h, box.ty) : JNULL;
      }
      case lua.LUA_TFUNCTION:
        return { k: "code", fn: nameForFunction(S, i) };
      default:
        return JNULL;
    }
  };

  // --- Lua functions the engine can call ----------------------------------------------
  //
  // Identity lives in a Lua TABLE keyed by the function itself, so the same function handed
  // over twice is one host entry (a trigger action added twice is one action, and two `code`
  // values of the same function compare equal). The table also keeps every one of them alive.

  const FN_TABLE = "__ow3_fns";
  lua.lua_createtable(L, 0, 0);
  lua.lua_setglobal(L, to_luastring(FN_TABLE));
  cachedEngineNames.add(FN_TABLE);

  /** Register the function at `S[i]`, and answer the name the engine knows it by. */
  function nameForFunction(S: LuaState, i: number): string {
    lua.lua_getglobal(S, to_luastring(FN_TABLE));
    lua.lua_pushvalue(S, i < 0 ? i - 1 : i);
    lua.lua_rawget(S, -2);
    if (lua.lua_type(S, -1) === lua.LUA_TSTRING) {
      const known = to_jsstring(lua.lua_tostring(S, -1));
      lua.lua_pop(S, 2);
      return known;
    }
    lua.lua_pop(S, 1);
    const name = `lua@${nextAnonymous++}`;
    lua.lua_pushvalue(S, i < 0 ? i - 1 : i);
    lua.lua_pushstring(S, to_luastring(name));
    lua.lua_rawset(S, -3);
    // …and the reverse direction, so the call can find the function again by name.
    lua.lua_pushstring(S, to_luastring(name));
    lua.lua_pushvalue(S, i < 0 ? i - 2 : i);
    lua.lua_rawset(S, -3);
    lua.lua_pop(S, 1);
    rt.hostFunctions.set(name, hostFunctionFor(name));
    published.add(name);
    return name;
  }

  /** Put the function registered under `name` on `S`'s stack. False if it has gone. */
  function pushFunction(S: LuaState, name: string): boolean {
    lua.lua_getglobal(S, to_luastring(FN_TABLE));
    lua.lua_pushstring(S, to_luastring(name));
    lua.lua_rawget(S, -2);
    if (lua.lua_type(S, -1) !== lua.LUA_TFUNCTION) {
      lua.lua_pop(S, 2);
      return false;
    }
    // Leave only the function on the stack — drop the table underneath it.
    lua.lua_remove(S, -2);
    return true;
  }

  /** Drive a registered Lua function as a COROUTINE, yielding the seconds it asks to sleep. */
  function* runCoroutine(name: string, args: JassValue[]): Generator<number, JassValue, void> {
    const co = lua.lua_newthread(L);
    // `lua_newthread` left the thread on L's stack; ref it so a sleep cannot collect it, and
    // take the stack slot back.
    const threadRef = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX);
    try {
      if (!pushFunction(co, name)) {
        rt.warnOnce(name, "the Lua function is gone — call dropped");
        return JNULL;
      }
      for (const a of args) push(co, a);
      let nargs = args.length;
      for (let i = 0; i < MAX_RESUMES; i++) {
        const status = lua.lua_resume(co, null, nargs);
        if (status === lua.LUA_YIELD) {
          const secs = lua.lua_gettop(co) ? Math.max(MIN_WAIT, lua.lua_tonumber(co, -1)) : MIN_WAIT;
          lua.lua_settop(co, 0);
          nargs = 0;
          yield secs;
          continue;
        }
        if (status !== lua.LUA_OK) {
          rt.warnOnce(name, `Lua error: ${lua.lua_gettop(co) ? to_jsstring(lua.lua_tostring(co, -1)) : "?"}`);
          return JNULL;
        }
        return lua.lua_gettop(co) ? read(co, -1) : JNULL;
      }
      rt.warnOnce(name, `did not finish in ${MAX_RESUMES} resumes — abandoned`);
      return JNULL;
    } finally {
      lauxlib.luaL_unref(L, lua.LUA_REGISTRYINDEX, threadRef);
    }
  }

  function hostFunctionFor(name: string): HostFunction {
    return {
      // The synchronous door: a condition, a boolexpr filter, an enum callback. A wait here
      // has nowhere to park — which is what WC3 says about the same places.
      call(args: JassValue[]): JassValue {
        const gen = runCoroutine(name, args);
        const first = gen.next();
        if (first.done) return first.value;
        rt.warnOnce(name, "wait outside a trigger thread — callback abandoned");
        return JNULL;
      },
      run(args: JassValue[]) {
        return runCoroutine(name, args);
      },
    };
  }

  // --- the globals bridge ---------------------------------------------------------------

  /** A closure that calls the engine function `name` with whatever Lua passed. */
  const pushEngineClosure = (S: LuaState, name: string): void => {
    lua.lua_pushjsfunction(S, (C: LuaState) => {
      const n = lua.lua_gettop(C);
      const args: JassValue[] = [];
      for (let i = 1; i <= n; i++) args.push(read(C, i));
      let out: JassValue;
      try {
        // `adoptWaits`: a BJ that sleeps is handed to the scheduler rather than abandoned,
        // which is the same answer the JASS side gives a wait it cannot park inline.
        out = interp.callFunction(name, args, true);
      } catch (err) {
        rt.warnOnce(name, `threw from Lua: ${(err as Error).message}`);
        out = JNULL;
      }
      push(C, out);
      return 1;
    });
  };

  /** `FourCC("hfoo")` — a rawcode as the integer a JASS literal would have been. */
  const pushFourCC = (S: LuaState): void => {
    lua.lua_pushjsfunction(S, (C: LuaState) => {
      const code = lua.lua_gettop(C) ? asStr(read(C, 1)) : "";
      lua.lua_pushinteger(C, rawcodeToInt(code) | 0);
      return 1;
    });
  };

  /** `TriggerSleepAction` / `PolledWait` — yield the coroutine instead of calling blizzard.j. */
  const pushWaitClosure = (S: LuaState): void => {
    lua.lua_pushjsfunction(S, (C: LuaState) => {
      const secs = lua.lua_gettop(C) ? Math.max(MIN_WAIT, asNum(read(C, 1))) : MIN_WAIT;
      lua.lua_settop(C, 0);
      // Nowhere to yield TO: the chunk's own top level, or a callback reached THROUGH a JASS
      // BJ (Lua cannot yield across a JS call). Say so once and carry on rather than raising
      // a Lua error, which at load time would take the whole map's script down with it.
      if (!lua.lua_isyieldable(C)) {
        rt.warnOnce("TriggerSleepAction", "wait with no coroutine to park — carried on without sleeping");
        return 0;
      }
      lua.lua_pushnumber(C, secs);
      return lua.lua_yield(C, 1);
    });
  };

  installGlobalsBridge();
  installPrint();

  function installGlobalsBridge(): void {
    lua.lua_pushglobaltable(L);
    lua.lua_createtable(L, 0, 2);

    lua.lua_pushstring(L, to_luastring("__index"));
    lua.lua_pushjsfunction(L, (S: LuaState) => {
      const key = to_jsstring(lua.lua_tostring(S, 2));
      // A JASS GLOBAL is read LIVE and never cached (see note 1).
      const g = rt.globals.get(key);
      if (g !== undefined) { push(S, g); return 1; }
      if (INTERCEPTED.has(key)) { pushWaitClosure(S); cacheGlobal(S, key); return 1; }
      if (LUA_ONLY.has(key)) { pushFourCC(S); cacheGlobal(S, key); return 1; }
      // A name the runtime knows how to call: a native, a blizzard.j function, or a native
      // declared in common.j we have not written yet (which answers its typed default and
      // logs once, exactly as it does for a JASS map).
      if (rt.natives.has(key) || rt.functions.has(key) || rt.nativeReturns.has(key)) {
        pushEngineClosure(S, key);
        cacheGlobal(S, key);
        return 1;
      }
      lua.lua_pushnil(S);
      return 1;
    });
    lua.lua_settable(L, -3);

    lua.lua_pushstring(L, to_luastring("__newindex"));
    lua.lua_pushjsfunction(L, (S: LuaState) => {
      const key = to_jsstring(lua.lua_tostring(S, 2));
      // Write THROUGH to a JASS global that already exists, so the map's Lua and the
      // install's blizzard.j never hold two copies of one variable. `__newindex` fires only
      // for a key absent from `_G`, and this branch never adds one — so every later write
      // comes back here too.
      if (rt.globals.has(key)) { rt.assignGlobal(key, read(S, 3)); return 0; }
      lua.lua_pushvalue(S, 2);
      lua.lua_pushvalue(S, 3);
      lua.lua_rawset(S, 1);
      return 0;
    });
    lua.lua_settable(L, -3);

    lua.lua_setmetatable(L, -2);
    lua.lua_pop(L, 1);
  }

  /** Copy the value on top of `S` into `_G[key]` (leaving it on the stack). */
  function cacheGlobal(S: LuaState, key: string): void {
    cachedEngineNames.add(key);
    lua.lua_pushglobaltable(S);
    lua.lua_pushstring(S, to_luastring(key));
    lua.lua_pushvalue(S, -3);
    lua.lua_rawset(S, -3);
    lua.lua_pop(S, 1);
  }

  /** The map's own `print` — into the console the rest of the engine logs to, prefixed so a
   *  line from a map is never mistaken for one of ours. `print` is already in `_G` from
   *  `openlibs`, so the globals metatable never sees it; it is replaced outright. */
  function installPrint(): void {
    lua.lua_pushjsfunction(L, (S: LuaState) => {
      const parts: string[] = [];
      for (let i = 1, n = lua.lua_gettop(S); i <= n; i++) parts.push(asStr(read(S, i)));
      console.info(`[lua] ${parts.join("\t")}`);
      return 0;
    });
    lua.lua_setglobal(L, to_luastring("print"));
    cachedEngineNames.add("print");
  }

  // --- the prologue Blizzard's own Lua backend provides ---------------------------------

  function run(source: string, chunkName: string): void {
    const bytes = to_luastring(source);
    if (lauxlib.luaL_loadbuffer(L, bytes, null, to_luastring(`@${chunkName}`)) !== lua.LUA_OK) {
      const msg = lua.lua_gettop(L) ? to_jsstring(lua.lua_tostring(L, -1)) : "load failed";
      lua.lua_pop(L, 1);
      throw new Error(`${chunkName}: ${msg}`);
    }
    if (lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) {
      const msg = lua.lua_gettop(L) ? to_jsstring(lua.lua_tostring(L, -1)) : "run failed";
      lua.lua_pop(L, 1);
      throw new Error(`${chunkName}: ${msg}`);
    }
  }

  // `__jarray` is the one piece of the prologue a compiled map cannot do without: a JASS array
  // in Lua mode is a table that reads its TYPE'S DEFAULT at an index nobody has written, which
  // is what makes `udg_Count[7] + 1` work on a fresh array. Test of Faith Reborn calls it 390
  // times, once per array its triggers declare.
  run(`
    function __jarray(default_)
      return setmetatable({}, { __index = function() return default_ end })
    end
    -- A downloaded map is untrusted content: take the doors out of the sandbox away.
    ${SANDBOX_REMOVE.map((n) => `${n} = nil`).join("\n    ")}
    -- Deterministic by construction: a match is lockstep, so every client seeds the same.
    math.randomseed(${seed | 0})
  `, "openwar3-lua-prologue");

  /** The global FUNCTION names defined right now, as a set. */
  function globalFunctionNames(): string[] {
    const src = `
      local names = {}
      for k, v in pairs(_G) do
        if type(v) == 'function' and type(k) == 'string' then names[#names + 1] = k end
      end
      table.sort(names)
      return table.concat(names, '\\n')
    `;
    if (lauxlib.luaL_loadbuffer(L, to_luastring(src), null, to_luastring("@openwar3-lua-globals")) !== lua.LUA_OK) {
      lua.lua_pop(L, 1);
      return [];
    }
    if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) { lua.lua_pop(L, 1); return []; }
    const list = lua.lua_gettop(L) ? to_jsstring(lua.lua_tostring(L, -1)) : "";
    lua.lua_pop(L, 1);
    return list ? list.split("\n") : [];
  }

  const before = new Set(globalFunctionNames());

  return {
    load(source: string, chunkName: string): void {
      run(source, chunkName);
      // Publish the chunk's OWN global functions under their real names, so the interpreter
      // calls `config` and `main` exactly as it calls a JASS map's (see note 5). Anything that
      // was a global before the chunk ran is the standard library or one of our own cached
      // closures, and is left alone — publishing a cached `IsUnitAliveBJ` would make a host
      // function that calls itself.
      for (const name of globalFunctionNames()) {
        if (before.has(name) || cachedEngineNames.has(name) || rt.natives.has(name)) continue;
        lua.lua_getglobal(L, to_luastring(name));
        nameForFunctionNamed(name);
      }
    },
    hasFunction(name: string): boolean {
      return published.has(name);
    },
    functionCount(): number {
      return published.size;
    },
    dispose(): void {
      for (const name of published) rt.hostFunctions.delete(name);
      published.clear();
      handleBoxes.clear();
    },
  };

  /** Register the function on top of the stack under a REAL name (pops it). */
  function nameForFunctionNamed(name: string): void {
    lua.lua_getglobal(L, to_luastring(FN_TABLE));
    lua.lua_pushstring(L, to_luastring(name));
    lua.lua_pushvalue(L, -3);
    lua.lua_rawset(L, -3);
    lua.lua_pushvalue(L, -2);
    lua.lua_pushstring(L, to_luastring(name));
    lua.lua_rawset(L, -3);
    lua.lua_pop(L, 2);
    rt.hostFunctions.set(name, hostFunctionFor(name));
    published.add(name);
  }
}
