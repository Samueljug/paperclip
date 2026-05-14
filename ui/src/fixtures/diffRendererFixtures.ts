import { parsePatchFiles } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs";

const smallDiffPatch = `diff --git a/src/pagination.ts b/src/pagination.ts
index 6c2a1f4..e91d2ac 100644
--- a/src/pagination.ts
+++ b/src/pagination.ts
@@ -1,8 +1,12 @@
 export type PageRequest = {
   limit: number;
+  cursor?: string;
   offset: number;
 };
 
 export function buildOffset(offset: number, limit: number) {
-  return { offset, limit };
+  return {
+    offset,
+    limit,
+    hasMore: limit > 0,
+  };
 }
`; 

const largeDiffPatch = `diff --git a/tmp/pierre-large-old.ts b/tmp/pierre-large-new.ts
index 6ea4ef1..9449233 100644
--- a/tmp/pierre-large-old.ts
+++ b/tmp/pierre-large-new.ts
@@ -1,160 +1,163 @@
 export const value_001 = '1';
 export const value_002 = '2';
-export const value_003 = '3';
+export const value_003 = '6';
 export const value_004 = '4';
 export const value_005 = '5';
-export const value_006 = '6';
+export const value_006 = '12';
 export const value_007 = '7';
 export const value_008 = '8';
-export const value_009 = '9';
+export const value_009 = '18';
 export const value_010 = '10';
 export const value_011 = '11';
-export const value_012 = '12';
+export const value_012 = '24';
 export const value_013 = '13';
 export const value_014 = '14';
-export const value_015 = '15';
+export const value_015 = '30';
 export const value_016 = '16';
 export const value_017 = '17';
-export const value_018 = '18';
+export const value_018 = '36';
 export const value_019 = '19';
 export const value_020 = '20';
+export function isEven(n: number) {
+  return n % 2 === 0;
+}
 
-export const value_021 = '21';
+export const value_021 = '42';
 export const value_022 = '22';
 export const value_023 = '23';
-export const value_024 = '24';
+export const value_024 = '48';
 export const value_025 = '25';
 export const value_026 = '26';
-export const value_027 = '27';
+export const value_027 = '54';
 export const value_028 = '28';
 export const value_029 = '29';
-export const value_030 = '30';
+export const value_030 = '60';
 export const value_031 = '31';
 export const value_032 = '32';
-export const value_033 = '33';
+export const value_033 = '66';
 export const value_034 = '34';
 export const value_035 = '35';
-export const value_036 = '36';
+export const value_036 = '72';
 export const value_037 = '37';
 export const value_038 = '38';
-export const value_039 = '39';
+export const value_039 = '78';
 export const value_040 = '40';
 export const value_041 = '41';
-export const value_042 = '42';
+export const value_042 = '84';
 export const value_043 = '43';
 export const value_044 = '44';
-export const value_045 = '45';
+export const value_045 = '90';
 export const value_046 = '46';
 export const value_047 = '47';
-export const value_048 = '48';
+export const value_048 = '96';
 export const value_049 = '49';
 export const value_050 = '50';
-export const value_051 = '51';
+export const value_051 = '102';
 export const value_052 = '52';
 export const value_053 = '53';
-export const value_054 = '54';
+export const value_054 = '108';
 export const value_055 = '55';
 export const value_056 = '56';
-export const value_057 = '57';
+export const value_057 = '114';
 export const value_058 = '58';
 export const value_059 = '59';
-export const value_060 = '60';
+export const value_060 = '120';
 export const value_061 = '61';
 export const value_062 = '62';
-export const value_063 = '63';
+export const value_063 = '126';
 export const value_064 = '64';
 export const value_065 = '65';
-export const value_066 = '66';
+export const value_066 = '132';
 export const value_067 = '67';
 export const value_068 = '68';
-export const value_069 = '69';
+export const value_069 = '138';
 export const value_070 = '70';
 export const value_071 = '71';
-export const value_072 = '72';
+export const value_072 = '144';
 export const value_073 = '73';
 export const value_074 = '74';
-export const value_075 = '75';
+export const value_075 = '150';
 export const value_076 = '76';
 export const value_077 = '77';
-export const value_078 = '78';
+export const value_078 = '156';
 export const value_079 = '79';
 export const value_080 = '80';
-export const value_081 = '81';
+export const value_081 = '162';
 export const value_082 = '82';
 export const value_083 = '83';
-export const value_084 = '84';
+export const value_084 = '168';
 export const value_085 = '85';
 export const value_086 = '86';
-export const value_087 = '87';
+export const value_087 = '174';
 export const value_088 = '88';
 export const value_089 = '89';
-export const value_090 = '90';
+export const value_090 = '180';
 export const value_091 = '91';
 export const value_092 = '92';
-export const value_093 = '93';
+export const value_093 = '186';
 export const value_094 = '94';
 export const value_095 = '95';
-export const value_096 = '96';
+export const value_096 = '192';
 export const value_097 = '97';
 export const value_098 = '98';
-export const value_099 = '99';
+export const value_099 = '198';
 export const value_100 = '100';
 export const value_101 = '101';
-export const value_102 = '102';
+export const value_102 = '204';
 export const value_103 = '103';
 export const value_104 = '104';
-export const value_105 = '105';
+export const value_105 = '210';
 export const value_106 = '106';
 export const value_107 = '107';
-export const value_108 = '108';
+export const value_108 = '216';
 export const value_109 = '109';
 export const value_110 = '110';
-export const value_111 = '111';
+export const value_111 = '222';
 export const value_112 = '112';
 export const value_113 = '113';
-export const value_114 = '114';
+export const value_114 = '228';
 export const value_115 = '115';
 export const value_116 = '116';
-export const value_117 = '117';
+export const value_117 = '234';
 export const value_118 = '118';
 export const value_119 = '119';
-export const value_120 = '120';
+export const value_120 = '240';
 export const value_121 = '121';
 export const value_122 = '122';
-export const value_123 = '123';
+export const value_123 = '246';
 export const value_124 = '124';
 export const value_125 = '125';
-export const value_126 = '126';
+export const value_126 = '252';
 export const value_127 = '127';
 export const value_128 = '128';
-export const value_129 = '129';
+export const value_129 = '258';
 export const value_130 = '130';
 export const value_131 = '131';
-export const value_132 = '132';
+export const value_132 = '264';
 export const value_133 = '133';
 export const value_134 = '134';
-export const value_135 = '135';
+export const value_135 = '270';
 export const value_136 = '136';
 export const value_137 = '137';
-export const value_138 = '138';
+export const value_138 = '276';
 export const value_139 = '139';
 export const value_140 = '140';
-export const value_141 = '141';
+export const value_141 = '282';
 export const value_142 = '142';
 export const value_143 = '143';
-export const value_144 = '144';
+export const value_144 = '288';
 export const value_145 = '145';
 export const value_146 = '146';
-export const value_147 = '147';
+export const value_147 = '294';
 export const value_148 = '148';
 export const value_149 = '149';
-export const value_150 = '150';
+export const value_150 = '300';
 export const value_151 = '151';
 export const value_152 = '152';
-export const value_153 = '153';
+export const value_153 = '306';
 export const value_154 = '154';
 export const value_155 = '155';
-export const value_156 = '156';
+export const value_156 = '312';
 export const value_157 = '157';
 export const value_158 = '158';
-export const value_159 = '159';
+export const value_159 = '318';
 export const value_160 = '160';
`;

function parsePatchFilesOrEmpty(patch: string): FileDiffMetadata[] {
  return parsePatchFiles(patch).flatMap((entry) => entry.files);
}

export type DiffRendererFixtureId = "small" | "large";

export interface DiffRendererFixture {
  id: DiffRendererFixtureId;
  label: string;
  patch: string;
  fileDiffs: FileDiffMetadata[];
}

export const DIFF_RENDERER_FIXTURES: DiffRendererFixture[] = [
  {
    id: "small",
    label: "Small mixed edit fixture",
    patch: smallDiffPatch,
    fileDiffs: parsePatchFilesOrEmpty(smallDiffPatch),
  },
  {
    id: "large",
    label: "Large 160-line patch fixture",
    patch: largeDiffPatch,
    fileDiffs: parsePatchFilesOrEmpty(largeDiffPatch),
  },
];

