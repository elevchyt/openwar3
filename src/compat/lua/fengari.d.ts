// Minimal typings for the slice of fengari this host uses (docs/map-compatibility.md).
//
// fengari ships no types. Rather than pull in a loose `any`, the surface is declared here —
// it is small, it is the C API one-for-one, and a typo in a name is then a compile error
// instead of a runtime "undefined is not a function" in the middle of a map's init.

declare module "fengari" {
  /** A Lua state (or a coroutine's thread state). Opaque to us. */
  export type LuaState = unknown;

  export const lua: {
    LUA_OK: number; LUA_YIELD: number; LUA_ERRRUN: number;
    LUA_TNONE: number; LUA_TNIL: number; LUA_TBOOLEAN: number; LUA_TLIGHTUSERDATA: number;
    LUA_TNUMBER: number; LUA_TSTRING: number; LUA_TTABLE: number; LUA_TFUNCTION: number;
    LUA_TUSERDATA: number; LUA_TTHREAD: number;
    LUA_REGISTRYINDEX: number;
    LUA_MULTRET: number;

    lua_gettop(L: LuaState): number;
    lua_settop(L: LuaState, n: number): void;
    lua_pop(L: LuaState, n: number): void;
    lua_type(L: LuaState, i: number): number;
    lua_isinteger(L: LuaState, i: number): boolean;
    lua_toboolean(L: LuaState, i: number): boolean;
    lua_tointeger(L: LuaState, i: number): number;
    lua_tonumber(L: LuaState, i: number): number;
    lua_tostring(L: LuaState, i: number): Uint8Array;
    lua_touserdata(L: LuaState, i: number): unknown;
    lua_pushnil(L: LuaState): void;
    lua_pushboolean(L: LuaState, b: boolean): void;
    lua_pushinteger(L: LuaState, n: number): void;
    lua_pushnumber(L: LuaState, n: number): void;
    lua_pushstring(L: LuaState, s: Uint8Array): void;
    lua_pushlightuserdata(L: LuaState, v: unknown): void;
    lua_pushvalue(L: LuaState, i: number): void;
    lua_pushjsfunction(L: LuaState, fn: (L: LuaState) => number): void;
    lua_pushglobaltable(L: LuaState): void;
    lua_createtable(L: LuaState, narr: number, nrec: number): void;
    lua_settable(L: LuaState, i: number): void;
    lua_rawset(L: LuaState, i: number): void;
    lua_setmetatable(L: LuaState, i: number): number;
    lua_getglobal(L: LuaState, name: Uint8Array): number;
    lua_setglobal(L: LuaState, name: Uint8Array): void;
    lua_newthread(L: LuaState): LuaState;
    lua_resume(L: LuaState, from: LuaState | null, nargs: number): number;
    lua_pcall(L: LuaState, nargs: number, nresults: number, errfunc: number): number;
    lua_rawgeti(L: LuaState, t: number, n: number): number;
    lua_rawget(L: LuaState, t: number): number;
    lua_remove(L: LuaState, i: number): void;
    lua_insert(L: LuaState, i: number): void;
    lua_replace(L: LuaState, i: number): void;
    lua_yield(L: LuaState, nresults: number): number;
    lua_isyieldable(L: LuaState): boolean;
    lua_tojsstring(L: LuaState, i: number): string;
  };

  export const lauxlib: {
    luaL_newstate(): LuaState;
    luaL_loadbuffer(L: LuaState, buff: Uint8Array, size: number | null, name: Uint8Array): number;
    luaL_ref(L: LuaState, t: number): number;
    luaL_unref(L: LuaState, t: number, ref: number): void;
  };

  export const lualib: {
    luaL_openlibs(L: LuaState): void;
  };

  export function to_luastring(s: string, cache?: boolean): Uint8Array;
  export function to_jsstring(a: Uint8Array): string;
}
