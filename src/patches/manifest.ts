// Every patch file in data/, oldest first — src/patches/index.ts sorts them by version anyway.
// A file that is not listed here is not applied; tools/patch-check.cjs fails if the two
// disagree, so adding a release is: write data/<version>.json, import it below.

import p1_31_0 from "./data/1.31.0.json";
import p1_32_0 from "./data/1.32.0.json";
import p1_32_6 from "./data/1.32.6.json";
import p1_32_7 from "./data/1.32.7.json";
import p1_32_8 from "./data/1.32.8.json";
import p1_32_9 from "./data/1.32.9.json";
import p1_32_10 from "./data/1.32.10.json";
import p1_35_0 from "./data/1.35.0.json";
import p1_35_0_20063 from "./data/1.35.0.20063.json";
import p1_36_0 from "./data/1.36.0.json";
import p1_36_0_20214 from "./data/1.36.0.20214.json";
import p1_36_1 from "./data/1.36.1.json";
import p1_36_2 from "./data/1.36.2.json";
import p1_36_2_21214 from "./data/1.36.2.21214.json";
import p1_36_2_21228 from "./data/1.36.2.21228.json";
import p2_0_2 from "./data/2.0.2.json";
import p2_0_2_22796 from "./data/2.0.2.22796.json";
import p2_0_3 from "./data/2.0.3.json";
import p2_0_3_23101 from "./data/2.0.3.23101.json";
import p2_0_4 from "./data/2.0.4.json";

export const PATCH_FILES = [
  p1_31_0,
  p1_32_0,
  p1_32_6,
  p1_32_7,
  p1_32_8,
  p1_32_9,
  p1_32_10,
  p1_35_0,
  p1_35_0_20063,
  p1_36_0,
  p1_36_0_20214,
  p1_36_1,
  p1_36_2,
  p1_36_2_21214,
  p1_36_2_21228,
  p2_0_2,
  p2_0_2_22796,
  p2_0_3,
  p2_0_3_23101,
  p2_0_4,
] as const;
