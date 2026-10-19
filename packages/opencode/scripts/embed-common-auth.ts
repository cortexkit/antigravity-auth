import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

export const inputPath =
  'tools/common-auth-build/inputs/cortexkit-common-auth-0.20.0.tgz'
export const producerVersion = '0.20.0'
export const artifactStatus = 'published'
export const outputPath = 'packages/opencode/src/common-auth-embedded'
export const productionPin = Object.freeze({
  sha256: 'd762d95b12173af425dc0bb131d5c62cccf3b5b9449c97f3568f2d121ae8e66c',
  sri: 'sha512-jq1pJkT9dWbD2RB0zambV2vcjbz5pODXXECxouT26WhsqJhopAdI/3sDgoFdjVLc38lZ5Q88GsHPo3F7UNjjyQ==',
})
export const publicRoots = {
  './rpc': { types: './dist/rpc/index.d.ts', import: './dist/rpc/index.js' },
  './rpc/client': {
    types: './dist/rpc/client.d.ts',
    import: './dist/rpc/client.js',
  },
  './logger': {
    types: './dist/logger/index.d.ts',
    import: './dist/logger/index.js',
  },
  './tui': { types: './dist/tui/index.d.ts', import: './dist/tui/index.js' },
  './store': {
    types: './dist/store/index.d.ts',
    import: './dist/store/index.js',
  },
  './fs': { types: './dist/fs/index.d.ts', import: './dist/fs/index.js' },
  './claustrum': {
    types: './dist/claustrum/index.d.ts',
    import: './dist/claustrum/index.js',
  },
  './setup': {
    types: './dist/setup/index.d.ts',
    import: './dist/setup/index.js',
  },
  './commands': {
    types: './dist/commands/index.d.ts',
    import: './dist/commands/index.js',
  },
  './auth-menu': {
    types: './dist/auth-menu/index.d.ts',
    import: './dist/auth-menu/index.js',
  },
  './routing': {
    types: './dist/routing/index.d.ts',
    import: './dist/routing/index.js',
  },
  './quota': {
    types: './dist/quota/index.d.ts',
    import: './dist/quota/index.js',
  },
  './pi-slot': {
    types: './dist/pi-slot/index.d.ts',
    import: './dist/pi-slot/index.js',
  },
  './opencode2': {
    types: './dist/opencode2/index.d.ts',
    import: './dist/opencode2/index.js',
  },
}

// Build-only destinations share one producer authority. Consumers cannot choose arbitrary payloads or paths.
export const embeddingProfiles = {
  opencode: { outputPath, publicRoots },
  core: {
    outputPath: 'packages/core/src/common-auth-embedded',
    publicRoots: {
      './store': publicRoots['./store'],
      './fs': publicRoots['./fs'],
      './claustrum': publicRoots['./claustrum'],
      './commands': publicRoots['./commands'],
      './auth-menu': publicRoots['./auth-menu'],
      './routing': publicRoots['./routing'],
      './quota': publicRoots['./quota'],
      './pi-slot': publicRoots['./pi-slot'],
    },
  },
} as const
export type CommonAuthEmbeddingPackage = keyof typeof embeddingProfiles

// The expected archive hashes are fixed constants, not computed from an existing output tree.
const canonical: readonly (readonly [string, number, string])[] = [
  [
    'auth-menu/accounts.d.ts',
    5145,
    '581ce15f0fcb2c7ca091276bd8e365d1638ba9b30ea3c3e0246e5be48ff44dff',
  ],
  [
    'auth-menu/accounts.js',
    15204,
    '6f85dc69b3bdabb8a868d5408df6030771937f33a5b2b6ec6716dfee153dd5c9',
  ],
  [
    'auth-menu/ansi.d.ts',
    1275,
    'ff3d391b2f62521afc6cd457a7a08b877a7d380b4c5c7224bb03f9c6f3aa7783',
  ],
  [
    'auth-menu/ansi.js',
    3475,
    'c751bb0239db4e32fcb636a8e9fe9b11e4602eed04858d4ae39ee79bf4f3cc3c',
  ],
  [
    'auth-menu/confirm.d.ts',
    385,
    'c2d6fca7c21fad42777e36014bbd776eeb4b454410214a7db4bfbd9f80f99101',
  ],
  [
    'auth-menu/confirm.js',
    746,
    '78e5d0a0d7c3ff86652b1388e5115486c34fc6198e262880956efc9ebdb55bfa',
  ],
  [
    'auth-menu/doctor.d.ts',
    2012,
    '2c0394fa76652d166edcbc46c996a0a39d45b11057943470cfe3d4019e0b2e5d',
  ],
  [
    'auth-menu/doctor.js',
    2982,
    'f36b95f7c1366f6fbadb3e157d0e6686171a6db062bca5ab6b4fbee0849658d8',
  ],
  [
    'auth-menu/index.d.ts',
    1452,
    'eca90e9bb04eadcc00c33aa3ef9d01b5b77fefffcdba0624af2f32d03e45e3f1',
  ],
  [
    'auth-menu/index.js',
    1007,
    'b0265ffabcaabf253d12b3735c985c647f1b8f86d2d94448f83e34d77f652ed4',
  ],
  [
    'auth-menu/login.d.ts',
    2211,
    'eb6d85bdff6cc5d614d263ba2e972e535bc5a770cbe1d98b6265341ce1085340',
  ],
  [
    'auth-menu/login.js',
    3698,
    'cced3c8bf07c9782f88b9b49d0ace79ff70c8b32919eba4856face9398a39eae',
  ],
  [
    'auth-menu/menu.d.ts',
    2209,
    'c3c53c1fa7e965f7183d02fa49b1d8378e7c31ffef35f83776082251fe4c6151',
  ],
  [
    'auth-menu/menu.js',
    2948,
    'acc8dea7a79533d01ff8332427d24e13b7c96210254864985f9a51e41406e9fc',
  ],
  [
    'auth-menu/opencode-v1.d.ts',
    2487,
    'fa485357ccf2e2d53a39801714b97cb0851ebb85b62e635c0b5f0c7c58ea1f5b',
  ],
  [
    'auth-menu/opencode-v1.js',
    2090,
    'd21c95a7acbcb9ea9abe15aaff8860272c98356a0143d957c52f58beb1f228de',
  ],
  [
    'auth-menu/select.d.ts',
    792,
    'b8ab301b531177d7a32e36ae58fd6f37e5e1250ad5bedc89c7d5513a298b7bbc',
  ],
  [
    'auth-menu/select.js',
    6431,
    '442bd3e3e8d288df217c24ad257b1498ef799f621c3a116b5509ad5c860c0272',
  ],
  [
    'auth-menu/terminal.d.ts',
    1747,
    '484080f56f6d219e6cca0e1027925bbf8cc1a8de35d995c88d4e13ecb230fd9f',
  ],
  [
    'auth-menu/terminal.js',
    594,
    '134d4950e10d5cd67fd28dba7af51f67e801e719d40b2824bf48e8dde55a1b7b',
  ],
  [
    'claustrum/availability.d.ts',
    3375,
    'eba8ff78abed434be6194715d214a53322f4414a28e6a7389fe14f8a52b772ac',
  ],
  [
    'claustrum/availability.js',
    4107,
    '4bfb03de131ed7d036631a6d6455cc6f465ab7a9ea61575a7378d2f447c7cf67',
  ],
  [
    'claustrum/consumer.d.ts',
    7663,
    '05f0ca84f69e72264a13d304da76937960f2a0bce966cfb8c702865df75117df',
  ],
  [
    'claustrum/consumer.js',
    19234,
    '38938cdcb6a4f3c368202f7d5c6b4a9ac3d742a71dd751a73d4275067be092ed',
  ],
  [
    'claustrum/custody.d.ts',
    10684,
    'f221ef617bc2a8ae9bfc5c177030ba80c9e5894daa5a1f378dc6cccfe3033ccb',
  ],
  [
    'claustrum/custody.js',
    20876,
    '174190a1547752da80e1a6300931ad631b137f6148912ced011481a778c78520',
  ],
  [
    'claustrum/enrollment.d.ts',
    7743,
    '7503e56a09f94e77a94a7ae15fd616f149ec9f675ec7c79bdea4a014ca014143',
  ],
  [
    'claustrum/enrollment.js',
    33520,
    'eeac604495c093503007478ab803c05b6e0bce8bf281f8bf9bbfee44c8ff85f1',
  ],
  [
    'claustrum/errors.d.ts',
    1145,
    'b7533d4c281807224d6d05f4bb7a596006862a6c05dc4462fae02af388054bce',
  ],
  [
    'claustrum/errors.js',
    199,
    '1d8a016bd08789154776174c1251f3a3c9b8b392b883040591c530564afd2ace',
  ],
  [
    'claustrum/host-slot.d.ts',
    1990,
    '1366b66f93ac7ce3410947771ffe05494d1360c52da9c525109c73be8fc425e8',
  ],
  [
    'claustrum/host-slot.js',
    3252,
    '59bd24af8dbf5d923750b6e2fb15de2ce8a59aa59e11a6740527e50d5f7f93d6',
  ],
  [
    'claustrum/index.d.ts',
    3189,
    '192814aa1063cf84eb7b845b92e2a7013b1728f94d1607ac1623fe74429d4e22',
  ],
  [
    'claustrum/index.js',
    2331,
    '5823e7ddf89510252919d4ab89450667891654108ee1fe20d7cb14364d6a6a00',
  ],
  [
    'claustrum/insula.d.ts',
    2489,
    '21a92525f04810a15a877e1c1ff9d7cf2fc2eb4ffe8a6aa408db22da6337d30f',
  ],
  [
    'claustrum/insula.js',
    6097,
    '1db6a99b9db96635bbf846e58ab54eaaa1892bf8939801a181741022d47ce428',
  ],
  [
    'claustrum/interlock.d.ts',
    1639,
    '458e8fd709f790d4a3ca51125cf9aa72e21d7ac957212945fcbc617398ee05b6',
  ],
  [
    'claustrum/interlock.js',
    1267,
    '031b95ccc3b3779ddb3be78278b29d6b2a741fc8217443a610ad2f98fe33ef33',
  ],
  [
    'claustrum/roster.d.ts',
    9932,
    '7c5684ff5c3f66d418f3624d07565a08556662f445cb96a7575a270851fab9c3',
  ],
  [
    'claustrum/roster.js',
    25106,
    'e6ac8f59dab51db4756ccbaa89fc73acd213a7a4795fdf5a7c7e4f653455fe94',
  ],
  [
    'commands/builtins.d.ts',
    2931,
    'b70028ea58b51d344e83ac62f36fa95499ab32af753e657ade8116491488bab9',
  ],
  [
    'commands/builtins.js',
    21323,
    '9b3461ace8a585dde5eff3f9b709ddc766ab3d77e680b687499efd1871a341ce',
  ],
  [
    'commands/index.d.ts',
    1081,
    'cfe14cdf7ae83a3bf37cfc3e4199c8f80e7720b982a0e875064113b1461c2967',
  ],
  [
    'commands/index.js',
    337,
    '1fbda89803e0ca21bd3e2f4ac01e5303b8858409e63467477ca4d3904bd16c53',
  ],
  [
    'commands/menu.d.ts',
    3181,
    '8c86a3e45fbe63a17447419ba73f6d2e99b4a3154995acd741a908dc71269776',
  ],
  [
    'commands/menu.js',
    12322,
    '910cf4b61bf407fa8580daadc86f17cde0b186351e20921a731c72486e7757fe',
  ],
  [
    'commands/model.d.ts',
    7986,
    '0b70d9cc750184dee6d4c1e7f117ec60417ab7889752ab9f0516694bae0524f2',
  ],
  [
    'commands/model.js',
    664,
    'ec1ddeedfda381d54ef3a6f3a2ade25622efd03233ead2545dbcab860ff024b7',
  ],
  [
    'commands/pi.d.ts',
    1061,
    'bd63b8b9118610fb8cb18d370cc154d3ef3cf3eab30c6d2c4398e3afe78f06c8',
  ],
  [
    'commands/pi.js',
    8194,
    '16bf28350d273af67ceed074ebf89af38cf5e8f32d2869a3a77d80488e4400b4',
  ],
  [
    'commands/seam.d.ts',
    3433,
    'bae574e565f9ccdc6ead34f959009e85c2a8f770cbd2ae152ec30e93b294e0b1',
  ],
  [
    'commands/seam.js',
    11326,
    '856649e0849e61d77201abae978ab69c4aa4613361468411da97ef0e0fb74584',
  ],
  [
    'fs/atomic-write.d.ts',
    1465,
    'd2117894a4fe94d3786dd7a126bce1d72748ba4c8f5838bcb880607b376886c4',
  ],
  [
    'fs/atomic-write.js',
    3450,
    '80779a8078e673ef68deaa7fdee3a0e1322078521a1f4156c0a595814c374044',
  ],
  [
    'fs/index.d.ts',
    626,
    '31ad80c3a005dfd3c78d1b8d1a2d4c23ce9d47dd9f6b5b8c3b9ec4f07c4b5cdb',
  ],
  [
    'fs/index.js',
    509,
    '26127c5a818c2ff0f66374f2dbbd93f57c6de7266acb2b2f61117e6e17e57f2b',
  ],
  [
    'fs/lock-constants.d.ts',
    324,
    '9ca698c0839bf00a57f6a82d754a3f95f09cbee1a9f364af3c33945a94b97ebc',
  ],
  [
    'fs/lock-constants.js',
    336,
    'cd60090325fa8c4c17dddfc216a4ed326f2a6e48525e724a4dd260bf88041231',
  ],
  [
    'fs/private-files.d.ts',
    3228,
    '1882d869cfebb3cebc8b9db47fb15083f8300c51c26c71666e898377fcd9a1ba',
  ],
  [
    'fs/private-files.js',
    12448,
    '1c8f34202b535d774d8c1a53bd403255f02701760c7378e020756c02c55a97c4',
  ],
  [
    'fs/refresh-file-lock.d.ts',
    2125,
    'ec643f4e081c108c1b42ceb17a83cf3e7e9997a4c75e1a61ffc33b5b44ccd414',
  ],
  [
    'fs/refresh-file-lock.js',
    29704,
    '5c52aad573e84e8065dcf06259ecf38345e8b5a2c401029a23d942f28c7a8521',
  ],
  [
    'fs/with-lock.d.ts',
    1153,
    'a0509ca4ee64b392b69c7a8555c7b33c0c223a8e58aec48848c3216350f1ba0c',
  ],
  [
    'fs/with-lock.js',
    1697,
    '35b4ed6dec77ffcb7850e655a35957da15c14a0fa27b6f3d1d634e243de43456',
  ],
  [
    'logger/capture-sink.d.ts',
    430,
    '20c88825e86688f16b6c1cd38c56980dacb66778b891ffff436348aeaa4a3849',
  ],
  [
    'logger/capture-sink.js',
    249,
    'b582535e350e6683f3de2cd1e4147f893afcb739f747f2bd1f713aaba513d604',
  ],
  [
    'logger/engine.d.ts',
    4612,
    '48e339153dcd7f5389ce9c10e4ad4a06066bcece866d62c70c0fa39f87f0bb1a',
  ],
  [
    'logger/engine.js',
    12539,
    '03d858547caa2e6f0e9c36759f11f442dfd6c11a20a6714eae35dea832f1444f',
  ],
  [
    'logger/index.d.ts',
    524,
    'aed1dff9371ca9fd2d3da44ef89a83d6df96274746e18a87058c8551db5a3a9d',
  ],
  [
    'logger/index.js',
    261,
    'ea9861f27c73b0194287ead55622b2a16cba3cacb90ad87e4b60e3bd0cb850c3',
  ],
  [
    'logger/redact.d.ts',
    474,
    '4a74e923b467320e26426f21ed88c8f86ddac42b39acfdbf3e64f97584d132a8',
  ],
  [
    'logger/redact.js',
    3989,
    '32c85066ec28d52043c9c0b56a363fe4d5b01159dd369796353edde360472f10',
  ],
  [
    'opencode2/errors.d.ts',
    1054,
    '5a89d3847b311f7bad67794086f7da57233657a64d675be16e2a2ff64f761050',
  ],
  [
    'opencode2/errors.js',
    483,
    'ae976bd2419bd289f5a40952e0ca9f2a50fda66ae0a70995f66b931731079463',
  ],
  [
    'opencode2/index.d.ts',
    1153,
    '4fb35e7d8c81d9f4515d57eb22a405ae171d75a6c6ed679faa3056b54ea9a128',
  ],
  [
    'opencode2/index.js',
    444,
    '56dee0a87581451f41cab5b6baabdbe37d54679caf32ae0406473e2592dafbf9',
  ],
  [
    'opencode2/install.d.ts',
    3566,
    '9bdc589d379c353b74b401b3b4fc3eff6ab2fef19ab8a6737f4595b8155c9025',
  ],
  [
    'opencode2/install.js',
    36235,
    '9b16eb3d63bf5167d2f0fa660eb6576f66d012af245d592d59062014cc8669e7',
  ],
  [
    'opencode2/integration.d.ts',
    5337,
    'd2a152c1c3d43548f0fe45404e13c940069c436f0ca4e06d2a46472cd1a547a4',
  ],
  [
    'opencode2/integration.js',
    6674,
    '4a06e160f1155499263a35759403a4b32cb615e165fd14b9176eb6c3906aec62',
  ],
  [
    'opencode2/sse.d.ts',
    617,
    '8719ebdd486bfb73ca143555e5c131538dd0dc987984cca821c5b2dd8351d262',
  ],
  [
    'opencode2/sse.js',
    1794,
    '19cde808e9d3d412a12c9fdad35015e233260f5b1ee6bcf4ce3c9c6321d77c30',
  ],
  [
    'opencode2/types.d.ts',
    19205,
    'b612e0737e370f83e492afa59cb6f4205b6ab9743f0ec53c6272c754f24d2271',
  ],
  [
    'pi-slot/index.d.ts',
    230,
    '8b2c9f002a5f8ee7f5e1da5ed2f1e13e0acfbeb0c8d9f0296d5215c3150e8798',
  ],
  [
    'pi-slot/index.js',
    138,
    '4364d23400afcc9650b055673cccceacd2c1239bac4abe6cda34cf1e34a88472',
  ],
  [
    'pi-slot/lock.js',
    7385,
    '68b0c7c764b88391e466f3b9fa172df176bf21529399606bf84475f3b920db8b',
  ],
  [
    'pi-slot/slot.d.ts',
    2394,
    'b92f1590f1f0e4dbbc6331923b9d2cf95e3200936063d5ed192a186f3271eb17',
  ],
  [
    'pi-slot/slot.js',
    15120,
    '13a7d5941b79c6d444cf9dc6f23263cf9237146c7dd5de7d162dbc21e015532c',
  ],
  [
    'quota/codec.d.ts',
    585,
    '8289f7c656a2eedd444cddb83c412dd24bf726421e7706bf19df93b55877db06',
  ],
  [
    'quota/codec.js',
    491,
    '4e496ce03a8a23536b467168f1dc6a7ceffb06d00ae80cb8a8868f311b2f3a8a',
  ],
  [
    'quota/format.d.ts',
    4260,
    'f76541a2f0e1e04782ee8b61a3d0f6b3ba3c156bc0e57bfcbd427e00baf279b4',
  ],
  [
    'quota/format.js',
    12897,
    '69e546dbc935300ff3b01294479844177be3e288626e5edf0341e820a20c5580',
  ],
  [
    'quota/index.d.ts',
    1047,
    '1ed8a3feaf208860182d738c2ba732fbaa61b6613c1e0e14442418a76d743663',
  ],
  [
    'quota/index.js',
    511,
    '691e7db4bf6025770991f98adda82ca4cb9be45eeefa3709b114fb2decfdf66e',
  ],
  [
    'quota/map.d.ts',
    2901,
    '28ba151926d76d45051065b243032ae4f698a3c4f94b44f32341c97467c7faf6',
  ],
  [
    'quota/map.js',
    5669,
    '95339af4c80684b4e462f5ba32affeaa5f8b5885db599dc5e8ac1ffd1890d729',
  ],
  [
    'quota/merge.d.ts',
    1775,
    '3531d738712f40b79415cd58940c55bf4cce6827c500fc3912368ff012e31f25',
  ],
  [
    'quota/merge.js',
    7439,
    '64440806fd70d214eb6a6f4c98f3a6ba442ca48d39762395a202c25fbf08a23e',
  ],
  [
    'quota/projection.d.ts',
    2975,
    '65a1b13db0a4d21f8b4136af65888494c6d8a7e117e80879c96f75fc0b763ad9',
  ],
  [
    'quota/projection.js',
    5640,
    'be7012f1df5845a1f3377b148f35ffe029583c1b9b5426f70a7ba96f7b49a150',
  ],
  [
    'routing/admission.d.ts',
    2793,
    '89bce677803fb17e427bb2b487a1861343c2b03e1981b4d47711484d90d27ff7',
  ],
  [
    'routing/admission.js',
    5773,
    '745745ddca9bb590fc02f09f2c0ba93caf5b45af1ed992d15c6700cff551b6f0',
  ],
  [
    'routing/index.d.ts',
    1010,
    '96645df1147731d33dcecd1dac7fa6114e3ab28a1c81acfcd2da03908bfb4b45',
  ],
  [
    'routing/index.js',
    449,
    '96aec45dada2d89f9fb581821f9128d1cf5c73b88b57fcad30c480de2cd3fcc6',
  ],
  [
    'routing/ordered.d.ts',
    2251,
    '41ca3aa1306405a7eac565bf6438c9aa9cbdc3411f8918cdca9435d22128edca',
  ],
  [
    'routing/ordered.js',
    2601,
    'e491610dda778863e98ac193f00689445380f0e9adf83319b27545cceae44b6e',
  ],
  [
    'routing/pins.d.ts',
    1227,
    '4d08614e90a27f6666603ca41255d16213abfd8b92861e004ecb92529761705a',
  ],
  [
    'routing/pins.js',
    1531,
    'ead17b2482ba84cd641b4e7ae1a6d2eecb3473feabe5a2b6776b29a87dadc612',
  ],
  [
    'routing/sticky.d.ts',
    7063,
    '5634082a14c318d80db1eb539c1120c5a5a28add98150f9cc8a0583fa418c92c',
  ],
  [
    'routing/sticky.js',
    14763,
    'b10f825eb45c4dfd56da1812d4c956b6479c07974d95d07699bbc6793d3d6283',
  ],
  [
    'rpc/client.d.ts',
    241,
    '42786d690c2e7c264e9476b979f3502810ff3724f2136a013fc5bf7b4efb9150',
  ],
  [
    'rpc/client.js',
    85,
    '982d65b56be71c69bf9c4e74d32257394aee022324bd673655405c6a4e381e26',
  ],
  [
    'rpc/index.d.ts',
    417,
    '62bda8e27c98b193ba0aee81a9e405472688618952907d91c53b9635b1142eef',
  ],
  [
    'rpc/index.js',
    172,
    '31aadda5190c9f8c5dd4b7c0f4bb11ce87fb79715ac4785163008fb5f0062998',
  ],
  [
    'rpc/notifications.d.ts',
    3333,
    'a635624ced52a0a747ee7df1576bf9249a69a22c7c19cff827a50624b246d666',
  ],
  [
    'rpc/notifications.js',
    3786,
    '80fa1e961293ff0dcbba6e1e2264d765f8a7a92916028fd7e21245ac68902171',
  ],
  [
    'rpc/port-file.d.ts',
    1637,
    'a6923d164510ffefd54714320690ad79df61d3b6f6718669d990190ca6a60f94',
  ],
  [
    'rpc/port-file.js',
    8738,
    '941c6d4804ce576520b69b1409b2c808e7c5f344a424262b047d8a72563b1faa',
  ],
  [
    'rpc/rpc-client.d.ts',
    1719,
    'c51f2fb15e862f948c044a83790a9395f4e0638ff0e587bafa7b4a840fccdd62',
  ],
  [
    'rpc/rpc-client.js',
    11857,
    '91c0a264be7e080c50f90126ab0ed457398dbdb68349a5edfccc1cb61b654e30',
  ],
  [
    'rpc/rpc-server.d.ts',
    2676,
    'cd60d433c1d0d763544b7ee5c78f905bfffb332bc2622586971b90f8e37dc27d',
  ],
  [
    'rpc/rpc-server.js',
    13765,
    'eb9fc24814e9de6ce1b6ecbc7d0ea906f46a99a81f507b0f4abfc6fdccb2df83',
  ],
  [
    'rpc/server-registry.d.ts',
    507,
    '94289df522440d9f92b7de74185090e8072a18f1b1ad7832584f2b1a0285b691',
  ],
  [
    'rpc/server-registry.js',
    1537,
    '7a7bb67f11f072e2fd655694445458295c5461579bc4e73b11559c9d18d3c93d',
  ],
  [
    'setup/command-error.d.ts',
    1498,
    'fd447696460a03cb04842a5984e9801797c09e1789da1f006f7f8e0943bd7d60',
  ],
  [
    'setup/command-error.js',
    3307,
    '2ead4c487c2dfc6e25cdc56362650ed294d1422fe9b705fbcc842ad1aac0ab10',
  ],
  [
    'setup/command-runner.js',
    5843,
    'd7f745555acbdd67a63049efcdb59e3daed7c7f68302baa65403315a14e2da6b',
  ],
  [
    'setup/command.d.ts',
    340,
    '65205bfcb3b240600a89c917b48154314115f5abef6ba1840024f2ca9711c79c',
  ],
  [
    'setup/command.js',
    13180,
    'ed9ff680ea01e09b9d443018b1d4746cb2e54200970165d3ddd76104f631bf12',
  ],
  [
    'setup/config-write.js',
    2368,
    '7f1561a53100f33cbc37fe6807035ca9bc3ade6250b8ee39cb7aba3431e93717',
  ],
  [
    'setup/detect.d.ts',
    498,
    '81e4f3d636f69d1d7e19f8db90cb6e3b7efe5434c26d8f6354033e03b59ee584',
  ],
  [
    'setup/detect.js',
    8226,
    '025b5f7b429978cc3842cc72240b8bc154a86859ceb2ad3b5ad8636ab334e649',
  ],
  [
    'setup/enroll.js',
    4022,
    '233b36d6422c93e7de0f7e73d1c09fdac54d8ae4090b15b91e1b99160e1ad0fa',
  ],
  [
    'setup/index.d.ts',
    842,
    '43b22470cb458058db2bc628e6502f4cd55184deff519c86213dd8d0e3e0000e',
  ],
  [
    'setup/index.js',
    517,
    '4b00ca576b580ce54b53c2ef6c2a03d1e00c3fde9d3174328cd7458edd38ec79',
  ],
  [
    'setup/paths.js',
    1194,
    'd87c664a34c81fe5b3515bc32821b8bbfee751e998e61f589986603b64e0ad20',
  ],
  [
    'setup/process-fence.d.ts',
    1615,
    '9eda9454a17fb7f8482746d9e8cf0e04a81f752d3ccff07a77880966a3550e7d',
  ],
  [
    'setup/process-fence.js',
    10923,
    'e2db85ab7ae29b99e9801787c0bb4f0bf58acc5b8c231a0c4acef30cde812747',
  ],
  [
    'setup/prompts.js',
    1023,
    'a0b1479c53ff444c73d72b3bfb001faa3834544869958729b0b524837f7ce056',
  ],
  [
    'setup/register.d.ts',
    744,
    '7a3a2dcfa6a459c307673516b692ba526aa6b3c1e2259ec8320a17055343e8c1',
  ],
  [
    'setup/register.js',
    6178,
    '65171657a6b2b5788bc3dea16729a045b70c73b0f6d37ada0f1864c889450dfe',
  ],
  [
    'setup/types.d.ts',
    5535,
    '69f8ee1e9345d72dec1e04bb5ce9fa38e6cc77339f53ad042b625c636c415068',
  ],
  [
    'store/attribution.d.ts',
    1528,
    '441dba300556a927e872597c1df3e4fbb1ac61c0a3989e98dcd3a94a773b8ed7',
  ],
  [
    'store/attribution.js',
    2880,
    '4bda762db5756c0d498d987aa3bc97eeee94be1c1ad2f005ed0ed46785e242d9',
  ],
  [
    'store/errors.d.ts',
    3191,
    '3f056ce51fd8bfa503604421df8b562a49154dc77dbe69b497e972787bc2e34f',
  ],
  [
    'store/errors.js',
    1432,
    '50be3531e432e91de73d67f15a66fed439d124802ae72d19f6c5d4c75cd670dc',
  ],
  [
    'store/hooks.d.ts',
    751,
    '38739bc4d1cd5e40df1dcbed711c97b813c3b1540aad575fb9decc563012129d',
  ],
  [
    'store/hooks.js',
    1269,
    'fa28be455f27671d530edf15773262398689295e28c28aef0ff9c1142c7f93b5',
  ],
  [
    'store/identity.d.ts',
    1951,
    '8cb1d95cd8fa6bf92d923ba638213f74ad494451622b4870b1dae934512b203f',
  ],
  [
    'store/identity.js',
    2923,
    '5f675917bbca5485a2f502ba14a8d31ab7d3d1e7077300ffb547a80e9a999a47',
  ],
  [
    'store/index.d.ts',
    2061,
    'ea8c2f617489679e3360840a892523601a32c4f448f5ee930145a4f00ce3ba3b',
  ],
  [
    'store/index.js',
    534,
    'ec9782b6e92e9fb2fe3b17b13d5dbbed0792c30cd0f04b84c1cdaa642f785db8',
  ],
  [
    'store/mutate.d.ts',
    9006,
    '009fea657c03a49b37555aa3c445c8930132234f0a1f3e8808ded5c065293ead',
  ],
  [
    'store/mutate.js',
    19981,
    '095842664fb1d805159902223b7765dd4a7349ad1a5bbb5e2c135c654739a434',
  ],
  [
    'store/pool.d.ts',
    10785,
    '192ea359d2ce746b31693cf06795a281f2e06804c567975f127ea05fa6fb4aef',
  ],
  [
    'store/pool.js',
    5671,
    '8dc0d27b37204c2c3229296e8efbbfac6bcb30538b39d8d95771267487a06292',
  ],
  [
    'store/provider-state.d.ts',
    7226,
    '5a34f11c74d1bbf6fcb384845085c0aacd9df28b8102141577690e9406475240',
  ],
  [
    'store/provider-state.js',
    11543,
    '755ba874f216cb91e3df39a084b991034f529596d2e75cd1ccc1884623ed7b40',
  ],
  [
    'store/publication.d.ts',
    1454,
    '2166d6a8d11dbc7c2a4e3edbae5a8ef86b01672f28e27a687ffe322ba4025eae',
  ],
  [
    'store/publication.js',
    15814,
    'fbb1376afb0f770529a8ea0a64c6db68272d3937cf13ee8a5063181667fd0a35',
  ],
  [
    'store/pull.d.ts',
    1626,
    'd37421210e6e339d3a4166933257588431ce2f83a0d23bc6d5da4deeca7dabb4',
  ],
  [
    'store/pull.js',
    5470,
    '4db913a0d196ed634277e4f3569c275579038f948e4adf6eb4dbbae257a41c92',
  ],
  [
    'store/refresh-lock.d.ts',
    2419,
    '50401b2e9b69b73592e0a4391fc1992a380539360b7cabfe5fce6d35fb29c648',
  ],
  [
    'store/refresh-lock.js',
    4655,
    'f2a316af681d1a14254873b9dc2d608a76919b7ba930636ee9f266c99195fb67',
  ],
  [
    'store/refresh.d.ts',
    2996,
    'c0ac1dcfd2393ac0683f4f4503a0b732ff35d621768a9fe6c3c69e05e43aa35c',
  ],
  [
    'store/refresh.js',
    10645,
    '698ad72c223ba36eda5005078e4303e726d9d9b8f3407c07b72ffa777466252c',
  ],
  [
    'store/reserved.js',
    536,
    '0d7f5f728cda7347c8dc6511f22ecd0bf5eb3553ce4426f97531c9ce2e636aae',
  ],
  [
    'store/rows.d.ts',
    15754,
    '4b3e06eeedfb46700409f6e1e6293e1f1b8c5574d2f18bd5006c404fd6d48c51',
  ],
  [
    'store/rows.js',
    61491,
    '6daf7b972b423d7c73283efebbba9af9473c566dd54a050699561e8e14d0ea96',
  ],
  [
    'store/runtime.d.ts',
    1949,
    '6838abdf1de68578c8403f76d3404a86e0d286c28a99ff32cb8bd84544a718cb',
  ],
  [
    'store/runtime.js',
    2847,
    'ffe3647d4a6f8cb6644b4cf4a00298d9ad89e2483b4dd6efa7f70baa2038461a',
  ],
  [
    'store/schema.d.ts',
    22290,
    '51a47144ee965680e517e8ec91210742908336f6b781f8be2026124d6d0a6bbf',
  ],
  [
    'store/schema.js',
    31533,
    'ae55f6f875ff8a9e9a09795eac1bedfd4bf795bd6802e8de37b52586b61208d0',
  ],
  [
    'store/settings.d.ts',
    2979,
    '2be15ac325bcfed048f12e202eaf625a6eca3f85fc35f29dff5770a31d81b7c5',
  ],
  [
    'store/settings.js',
    5176,
    'b96a54dfca4a59a592d6bfac82e388e9a4f4c158e4b01dc8864b4bc6becbc88c',
  ],
  [
    'store/torn.d.ts',
    3691,
    '9627cac1b1a93891f74577f9bb6a4832e423b3302fdd18be0d191b51cb615a6a',
  ],
  [
    'store/torn.js',
    14708,
    'd5a4338ef9795e4d638e221d40a25334909db74db6456e2823f5870f7c963854',
  ],
  [
    'tui/index.d.ts',
    281,
    '9d4555b13b599cdef275f1501154d3802ac237a17ee06fafd34e05a183918921',
  ],
  [
    'tui/index.js',
    950,
    'c9a1e381382128b64eea0b3b049beb1b210cb68e768ea04683662b8b1a73bbb1',
  ],
  [
    'util/any-signal.js',
    1508,
    '454adc21f90c42f5caa2c6b8374c1a7532623a1b954fe06a030afbc9248c10fe',
  ],
]

export const sha256 = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex')

function field(header: Buffer, start: number, end: number): string {
  const bytes = header.subarray(start, end)
  const zero = bytes.indexOf(0)
  return bytes.subarray(0, zero < 0 ? bytes.length : zero).toString('utf8')
}

function octal(value: string): number {
  if (!/^[0-7]+$/.test(value.trim()))
    throw new Error('archive: invalid numeric field')
  const number = Number.parseInt(value.trim(), 8)
  if (!Number.isSafeInteger(number))
    throw new Error('archive: numeric overflow')
  return number
}

/** Decode headers into memory without filesystem traversal.
 * Tests supply fixture hashes; the production function uses fixed publication hashes.
 */
export function readVerifiedArchive(
  compressed: Buffer,
  pin: Readonly<{ sha256: string; sri: string }>,
): Map<string, Buffer> {
  if (sha256(compressed) !== pin.sha256)
    throw new Error('integrity: SHA256 mismatch')
  const sri = `sha512-${createHash('sha512').update(compressed).digest('base64')}`
  if (sri !== pin.sri) throw new Error('integrity: SHA512 SRI mismatch')
  const tar = gunzipSync(compressed, { maxOutputLength: 16 * 1024 * 1024 })
  const entries = new Map<string, Buffer>()
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      if (
        tar.length - offset < 1024 ||
        !tar.subarray(offset).every((byte) => byte === 0)
      )
        throw new Error('archive: invalid end marker')
      return entries
    }
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    )
    if (octal(field(header, 148, 156)) !== checksum)
      throw new Error('archive: checksum mismatch')
    if (field(header, 257, 263) !== 'ustar')
      throw new Error('archive: unsupported header')
    const prefix = field(header, 345, 500)
    const name = `${prefix ? `${prefix}/` : ''}${field(header, 0, 100)}`
    if (
      !name.startsWith('package/') ||
      name.includes('\\') ||
      !/^[a-zA-Z0-9_./-]+$/.test(name) ||
      name.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error('archive: unsafe path')
    if (entries.has(name)) throw new Error('archive: duplicate path')
    const kind = header[156]
    if (kind === 50) throw new Error('archive: symlink')
    if (kind === 49) throw new Error('archive: hardlink')
    if (kind !== 48 && kind !== 0) throw new Error('archive: nonregular entry')
    if (field(header, 157, 257))
      throw new Error('archive: unexpected link target')
    const size = octal(field(header, 124, 136))
    const end = offset + 512 + size
    if (end > tar.length) throw new Error('archive: truncated payload')
    entries.set(name, tar.subarray(offset + 512, end))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error('archive: missing end marker')
}

export function validatePublication(
  entries: ReadonlyMap<string, Buffer>,
): void {
  const pkg = JSON.parse(
    entries.get('package/package.json')?.toString() ?? 'null',
  )
  if (pkg?.name !== '@cortexkit/common-auth')
    throw new Error('publication: identity')
  if (pkg.version !== producerVersion) throw new Error('publication: version')
  for (const [root, targets] of Object.entries(publicRoots)) {
    if (JSON.stringify(pkg.exports?.[root]) !== JSON.stringify(targets))
      throw new Error(`publication: exports ${root}`)
  }
  if (
    pkg.license !== 'MIT' ||
    sha256(entries.get('package/LICENSE') ?? '') !==
      'bf737fd6a5d9da55873eb7ea481fd9e875bcfefc13ed42766a1964c6040c5581'
  )
    throw new Error('publication: license')
  if (
    sha256(`${[...entries.keys()].sort().join('\n')}\n`) !==
    'd61acc40eb6cf7c84ca400577e35bf233d25e4b4d9c3fbf37a49dce89b634b0f'
  )
    throw new Error('publication: inventory')
  for (const [path, bytes, hash] of canonical) {
    const data = entries.get(`package/dist/${path}`)
    if (!data || data.length !== bytes || sha256(data) !== hash)
      throw new Error(`publication: bytes ${path}`)
  }
  if (
    sha256(entries.get('package/package.json') ?? '') !==
    '5fa40c7b5c8e4e05c33889c6cdffbf3555fe84d6bba091bfcb1e43a38a2a894f'
  )
    throw new Error('publication: manifest bytes')
}

async function inventory(directory: string, prefix = ''): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`
    if (entry.isDirectory())
      result.push(...(await inventory(join(directory, entry.name), `${path}/`)))
    else if (entry.isFile()) result.push(path)
    else throw new Error(`output: nonregular entry ${path}`)
  }
  return result.sort()
}

async function refuseSymlinks(root: string, path: string): Promise<void> {
  let current = root
  for (const part of path.split('/')) {
    current = join(current, part)
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (stat?.isSymbolicLink()) throw new Error(`output: symlink ${current}`)
  }
}

export async function embedCommonAuth(
  root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
  check = false,
): Promise<void> {
  await embedCommonAuthPackages(['opencode'], root, check)
}

function profileOutputs(
  entries: ReadonlyMap<string, Buffer>,
  consumer: CommonAuthEmbeddingPackage,
  generatorSha256: string,
): Map<string, Buffer> {
  const profile = embeddingProfiles[consumer]
  // Core's public roots need the menu, store, vault and routing closures, but never RPC or TUI.
  const selected = canonical.filter(
    ([path]) =>
      consumer === 'opencode' || !/^(?:rpc|tui|opencode2|setup)\//.test(path),
  )
  const files = selected.map(([output, bytes, hash]) => ({
    source: `package/dist/${output}`,
    output,
    bytes,
    sourceSha256: hash,
    outputSha256: hash,
    transform: 'verbatim',
  }))
  const manifest = {
    schema: 1,
    package: '@cortexkit/common-auth',
    version: producerVersion,
    artifactStatus,
    publicRoots: profile.publicRoots,
    input: inputPath,
    tarballSha256: productionPin.sha256,
    sri: productionPin.sri,
    canonicalFiles: files.length,
    canonicalBytes: files.reduce((total, file) => total + file.bytes, 0),
    generator: {
      path: 'packages/opencode/scripts/embed-common-auth.ts',
      version: 3,
      sha256: generatorSha256,
    },
    files,
    transforms: [],
    notice: {
      source: 'package/LICENSE',
      output: 'NOTICE.txt',
      sha256: sha256(entries.get('package/LICENSE')!),
    },
  }
  const outputs = new Map<string, Buffer>(
    files.map((file) => [file.output, entries.get(file.source)!]),
  )
  outputs.set(
    'source-output.json',
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
  )
  outputs.set('NOTICE.txt', entries.get('package/LICENSE')!)
  return outputs
}

/** Internal build coordination only; each package owns its fixed generated destination. */
export async function embedCommonAuthPackages(
  packages: readonly CommonAuthEmbeddingPackage[],
  root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
  check = false,
): Promise<void> {
  if (
    !packages.length ||
    new Set(packages).size !== packages.length ||
    packages.some((name) => !Object.hasOwn(embeddingProfiles, name))
  )
    throw new Error('output: expected unique known consumer packages')
  // Verify the fixed archive before inspecting outputs, so an input read or integrity failure stops processing before existing outputs are used.
  const entries = readVerifiedArchive(
    await readFile(join(root, inputPath)),
    productionPin,
  )
  validatePublication(entries)
  const generatorSha256 = sha256(await readFile(fileURLToPath(import.meta.url)))
  const targets = packages.map((name) => ({
    path: embeddingProfiles[name].outputPath,
    outputs: profileOutputs(entries, name, generatorSha256),
  }))
  // Admit every destination before any replacement. A refused second target cannot damage the first.
  for (const target of targets) await refuseSymlinks(root, target.path)
  const claimed: string[] = []
  try {
    for (const { path: targetPath, outputs } of targets) {
      const destination = join(root, targetPath)
      if (check) {
        if (
          JSON.stringify(await inventory(destination)) !==
          JSON.stringify([...outputs.keys()].sort())
        )
          throw new Error('output: inventory mismatch')
        for (const [path, bytes] of outputs) {
          if (!(await readFile(join(destination, path))).equals(bytes))
            throw new Error(`output: bytes ${path}`)
        }
      } else {
        claimed.push(destination)
        await rm(destination, { force: true, recursive: true })
        for (const [path, bytes] of outputs) {
          await mkdir(dirname(join(destination, path)), { recursive: true })
          await writeFile(join(destination, path), bytes)
        }
      }
    }
  } catch (error) {
    // Only destinations admitted and claimed by this invocation can be partial outputs.
    await Promise.all(
      claimed.map((path) => rm(path, { force: true, recursive: true })),
    )
    throw error
  }
}

if (import.meta.main) {
  if (process.argv.slice(2).some((arg) => arg !== '--check'))
    throw new Error('Usage: bun embed-common-auth.ts [--check]')
  await embedCommonAuth(undefined, process.argv.includes('--check'))
  console.log(
    `common-auth ${producerVersion} (${artifactStatus}): verified ${canonical.length} canonical files (${canonical.reduce((total, [, bytes]) => total + bytes, 0)} bytes) and MIT notice`,
  )
}
