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
  'tools/common-auth-build/inputs/cortexkit-common-auth-0.33.0.tgz'
export const producerVersion = '0.33.0'
export const artifactStatus = 'published'
export const outputPath = 'packages/opencode/src/common-auth-embedded'
export const productionPin = Object.freeze({
  sha256: 'bba9f56f7fb353c9c712113722c7c9361f0e13e930c73f57314185b13032a24c',
  sri: 'sha512-cbbyqXTK1TYQZNHb2xA/ueZGQsBvAX6H9hTlQcZZxM7SR/u7tsscyBAWw38ViXl1n/gwkqgsvs2Vbs6cZ0hOrw==',
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
  opencode: {
    outputPath,
    publicRoots: {
      ...publicRoots,
      './routing-accessor': {
        types: './dist/routing-accessor/index.d.ts',
        import: './dist/routing-accessor/index.js',
      },
      './quota-sidebar': {
        types: './dist/quota-sidebar/index.d.ts',
        import: './src/quota-sidebar/index.tsx',
      },
    },
  },
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
    2080,
    '059c952d50b86007a48dc53fefbc600df8708d84ee203942f1bb0f9262b67542',
  ],
  [
    'auth-menu/login.js',
    3972,
    'f55cb1e2a40cab6ef99b5386682615dca059e8d7d982f4a508306c225084f647',
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
    13934,
    '97e5fb096153912483b45f75831e4652db19457d94ad76ba8363b1fd232e6fd7',
  ],
  [
    'claustrum/consumer.js',
    39439,
    '3b4cf06be8732f3183ac97721dfffb8fc489d4be1044260742a72a9995324391',
  ],
  [
    'claustrum/custody.d.ts',
    16390,
    '3bbbfc2d700cf6c25356339c64d3bef5cee5e00336d141de18bb7522c8a5ceaa',
  ],
  [
    'claustrum/custody.js',
    31616,
    '5ed70e65b78a04ceec3b3430908f46c860ea768b779b6af0f925681fd786593d',
  ],
  [
    'claustrum/enrollment.d.ts',
    8530,
    '8e44065db1b28f930f01b9c267aacb23e2f4f9d5d7d358b815fdc8c5080450ff',
  ],
  [
    'claustrum/enrollment.js',
    36868,
    '7dab3edbc03542bcd75578449f6c3b92959671f0669332c62b2ad4525aa9c829',
  ],
  [
    'claustrum/errors.d.ts',
    1163,
    'a6e5ec8be3ae7160b78456e642b440494604c2e2cdc987550744521dc873fb40',
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
    'claustrum/hub.d.ts',
    9346,
    '4c2cbd91b3cc9691ee765f766b7c80d27cf28b38494a0a53ce9410c184e7ca1d',
  ],
  [
    'claustrum/hub.js',
    45993,
    'e50ebf6bcf840f8a4229d219ecb20fc1422c74b5b3aa2034dff0b73852380b79',
  ],
  [
    'claustrum/index.d.ts',
    4728,
    '524bec258d060b75e6aeefa1e39e102e9ad7370e6c74ba2c033fcc418a1db4d7',
  ],
  [
    'claustrum/index.js',
    3938,
    '9868c6c475ba9390118bd45c3b5dafe18a51c13cfe4e61700496e9096143a42b',
  ],
  [
    'claustrum/insula.d.ts',
    5463,
    'e1c9ecf858b7ecbb21c1f954cbd35b5ea77494e5aca9dbd198fe5e2cd0a3a95f',
  ],
  [
    'claustrum/insula.js',
    20137,
    'e2a2625cdad490cf24aa0badf66c842becd806738f8b137ebcf2b01e296eb0d2',
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
    'claustrum/quota-writer.d.ts',
    1483,
    'c3cafec7057092a67d443667bee50b19333dcf3a8d14b63c9fbe4ac3989ba389',
  ],
  [
    'claustrum/quota-writer.js',
    8527,
    '5375e7d8a300e73f4398d610090834095fd22ba4b3830f3c62d142a67dcbe9fd',
  ],
  [
    'claustrum/roster.d.ts',
    15102,
    '30fc3b4d572e43a08a700ff169ebcb52206d1200f7ca678d2bff0a3369aaa005',
  ],
  [
    'claustrum/roster.js',
    39340,
    '6919aa948f9022f76ce2b7aac83733bd7a11a8c21b8511191cf7fbf6bc1a2b30',
  ],
  [
    'claustrum/shutdown.js',
    1270,
    '6ccb19ab5e9bb84a978cb47a32b443abe432b4edfe69a318e45bb404ef75c45e',
  ],
  [
    'claustrum/watch.d.ts',
    5760,
    '54f088f0e6c863d75295721700a423e682bfd4a6735e02a03556b2faa379d991',
  ],
  [
    'claustrum/watch.js',
    9226,
    '6fdd6ed31d349da6cd016ebbd5f283ce595e9fab376a44cc6587cc9a13d8f589',
  ],
  [
    'commands/builtins.d.ts',
    4576,
    '5ab6cbab696c91fef0fc7288d4b82803cd0bac809b68f939d73671505fc1d894',
  ],
  [
    'commands/builtins.js',
    25155,
    'c5f7fca0e36dc2f3253b88e7600d3dbed6a193d2b8abbf07d16913b6b46551e6',
  ],
  [
    'commands/index.d.ts',
    1100,
    '4be7eec728211b7ad707121b1f2bbe2c219574aaa4e1c5be3f8964b185d4377c',
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
    'fs/file-read-cache.js',
    2121,
    '484d18996d76c44125c880347b3d3dcd10bb352743acf44c588d0b38e8e0f1a7',
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
    3398,
    'b344509a32fcd983f09e5814286630a53c8e577ad1b973eabe19f8e58659e8d3',
  ],
  [
    'fs/private-files.js',
    14779,
    '114c06ce4c0998087878d99c5dc37425e90d5fad205f57fe0bdf9694e3c8e31d',
  ],
  [
    'fs/refresh-file-lock.d.ts',
    3052,
    '31c23ba9135ddc57ea0196ad56280bd12eab2c9524d33bd43d78112da27214d2',
  ],
  [
    'fs/refresh-file-lock.js',
    37831,
    'e0fdcc7a45548f3c88ea49bbe000f6e4022fb9c219f0510aa934492adb72a505',
  ],
  [
    'fs/with-lock.d.ts',
    1179,
    '403d301f0cc332b72f8e7d904ac26f8efc93081cbd2cddd46b3f6a5a61d52685',
  ],
  [
    'fs/with-lock.js',
    3003,
    '690fb43c6a0eb6a02eac024b8b58caa39775a37d0064118dab879a0e5ac8c996',
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
    1298,
    '14d126de16a9b787108fe3a75ed1effdc09261cad42a89b4917984333e42c600',
  ],
  [
    'opencode2/errors.js',
    483,
    'ae976bd2419bd289f5a40952e0ca9f2a50fda66ae0a70995f66b931731079463',
  ],
  [
    'opencode2/index.d.ts',
    1251,
    '048d288a7c16c4cc8ae49414159ba2d25f2ba3237014778ad2151689e13ddd2a',
  ],
  [
    'opencode2/index.js',
    463,
    'a626e6a4f3511e07f1e52a0969b855884bd521f0f1382ad28ed35ca83b46fc1e',
  ],
  [
    'opencode2/install.d.ts',
    3919,
    'e6c201f36b9c021a38c395a09739ccc232cc1f6414189251097685d753099f50',
  ],
  [
    'opencode2/install.js',
    53838,
    '1ef58be234b760e6f8c5bb3b4eae892b3f9c2046ed07f4ac38f5bc20dbea330e',
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
    26581,
    'f1c778b5a56d5511313a1a0702035d9a2d42fa76fa6a44f5785598af2669ef04',
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
    8420,
    '533de03f6b53624301e75565b7d677382acec3c9eda9cfdb7265a0e868aaeb82',
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
    'quota/commit-interval.d.ts',
    283,
    '8b1d8b541a382d1ce366d65d9845e9d3848445cf075751b68ad963fb660ee04a',
  ],
  [
    'quota/commit-interval.js',
    864,
    '3281afb6df69d83a7c5898e1163287f34104068ddd4085b7460c4bb392967491',
  ],
  [
    'quota/format.d.ts',
    5816,
    '1865f4a06b8bd06b3dda73b59a7becc3eb2d13036134c1a34b8b6dce12678f21',
  ],
  [
    'quota/format.js',
    18881,
    'ffd69317391a225fb8e75550c22ea401480626cde762c52e61001955952ee013',
  ],
  [
    'quota/index.d.ts',
    1107,
    'bbc90a42ee076209b368a3ffd477b0554dbe86da63c7e345cd3515b8ffc8950a',
  ],
  [
    'quota/index.js',
    545,
    '781024edb9aa55a4cb88dfd0657abe569a1d9d15ac2b9a4a90456499a21a85fd',
  ],
  [
    'quota/map.d.ts',
    3876,
    '95a8545c91726fecad46289ffd7fb400b62c376bfbc44477348ae30efe2ee853',
  ],
  [
    'quota/map.js',
    6610,
    'c25cf67edc7d9cdc697d8956181d55cd13e823bead30c6acc82477c8222eb1df',
  ],
  [
    'quota/merge.d.ts',
    1997,
    'b1f5d76d4176b118f7dbc19dd7d2f986697c8ecae2476b2cbe0c5a2538560527',
  ],
  [
    'quota/merge.js',
    8096,
    'b1d76faf1fb480b97ef1886ce75dbd2156002baedc39249468559cb4eece5bbb',
  ],
  [
    'quota/pending.js',
    1876,
    'e757a3fa9f8440190668c6154468a5baec8a84e20d6c831a6d7935c3b9bebe29',
  ],
  [
    'quota/projection.d.ts',
    3661,
    'c4f4c8c53245bd0c8bd08a1483aede705a4c3e21e4a131f14835340ffee38fab',
  ],
  [
    'quota/projection.js',
    5787,
    '762f4ba4f64accc7f7344402897ddaad3cfc908c11ff8e6ee9b6277602b78702',
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
    14231,
    '62b92588917afeaa5ddb187c0e47fe5e318c313bc3e6065806052c3bef008f04',
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
    13573,
    '182db608585e2ab5d47a6c388fb46973739364d72f5df9b035875f765b7a6f79',
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
    'setup/enroll.d.ts',
    2274,
    '067d636aea631befae2548b5aeed01dc10c22e9c44efb43c31496fe8c0a9ab68',
  ],
  [
    'setup/enroll.js',
    8557,
    'dd21599c916733c327bca81c48372034a349a2840e50fac7d2d30b33668a1537',
  ],
  [
    'setup/flags.d.ts',
    1975,
    '8475bfc500aaaae2ccc4f6d6a90be029911c88082e1f6fe646d9a02e24aecd3c',
  ],
  [
    'setup/flags.js',
    4610,
    '6c424773289587568500e53a76e7a64074867bab6e97318ff9b619b93c694bfb',
  ],
  [
    'setup/index.d.ts',
    1011,
    '4a0f5a26bca035276077740d5fab9187000d15e575a6c195a0772d64d8c7e9f0',
  ],
  [
    'setup/index.js',
    658,
    '218409be186bc7e52d0606699502ccb272f024676018a1d1835a45573e2ea787',
  ],
  [
    'setup/paths.js',
    1194,
    'd87c664a34c81fe5b3515bc32821b8bbfee751e998e61f589986603b64e0ad20',
  ],
  [
    'setup/process-fence.d.ts',
    2223,
    'ed246d2c16821cc51170e4099466450e26821c81fc3b96ad2d7fde18ea4ee9c6',
  ],
  [
    'setup/process-fence.js',
    14008,
    '8ca9546a205fe9d6daecc2604c7e4608df5d09e0bd0f774fe8da40f26a3ffefb',
  ],
  [
    'setup/prompts.js',
    1023,
    'a0b1479c53ff444c73d72b3bfb001faa3834544869958729b0b524837f7ce056',
  ],
  [
    'setup/register.d.ts',
    816,
    '9f9c32e5eaea9623594b07dde03be3a03dec5e9569e882a7e769a9e14d67c317',
  ],
  [
    'setup/register.js',
    9616,
    '6318e5747df8b6e56ab4ac5e26fbc2d7446f4ab550d7a700cbc6ce19d8f80e7a',
  ],
  [
    'setup/types.d.ts',
    6038,
    'f4091b3f1f5018e9ac9b3da4329cb388302ef1c12c7c927fb43c631e1a0295f6',
  ],
  [
    'store/attribution.d.ts',
    1951,
    '16919a55fe944b459ff511c125ac2ba34714949d38db006c8ab047dd48ab51a6',
  ],
  [
    'store/attribution.js',
    3280,
    '5b54980a4f158c9b61cd90c4a83a14e83268fe98101fc88409500bb73d1126bb',
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
    9196,
    '4a46be98d9eb24a690e95f26b69bd3c461d5f225170bd31fcb89147c7baac41c',
  ],
  [
    'store/mutate.js',
    20171,
    'd61d08f2caed6d7a803ca4c67511e5133d28f21a90a7417f76e23b49ed00591d',
  ],
  [
    'store/pool.d.ts',
    12144,
    '64d6e7dd5600f436422e6d309a22b7f874a6afdd866873226ab1f4d5091ebc43',
  ],
  [
    'store/pool.js',
    6358,
    '1503b5c0f461678f9710a5fe22e345092de70e537a114e57b0cb651795928031',
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
    5602,
    '512a723a49dae3be50aa8c67ca8f6a5c165ec72e8a991a166d8d93e33e895350',
  ],
  [
    'store/quota-writer.js',
    12960,
    '7816549913b030045e5f7848dd57ca11841a3aa6051c30c96a7d09f82341700e',
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
    2100,
    '34efe7252b6c0aead222cab6164340e76e9c22202049158164c56c3b46bab91f',
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
    2994,
    '32446dea1f8431e3fb7e38940d1dec7259dbd5c794b4117efe3875be92405fef',
  ],
  [
    'store/settings.js',
    5766,
    '5ed4e0458800923b843b9b8f0671cca0c04cb26e428453e3bcc8b6d06b51470f',
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

type CanonicalEntry = {
  output: string
  bytes: number
  hash: string
} & (
  | { kind: 'dist'; source: `package/dist/${string}` }
  | { kind: 'source'; source: `package/src/${string}` }
)

// Compile the public TSX with the host renderer, reusing the adjacent quota modules.
// Authored source and its declaration belong to OpenCode, never the core profile.
const sidebarCanonical: readonly CanonicalEntry[] = [
  {
    kind: 'dist',
    source: 'package/dist/quota-sidebar/index.d.ts',
    output: 'quota-sidebar/index.d.ts',
    bytes: 2658,
    hash: 'a2f94067970c25ce042febadc87a1afdd5c43c75a5100fa8446a783a53ce2815',
  },
  {
    kind: 'source',
    source: 'package/src/quota-sidebar/index.tsx',
    output: 'quota-sidebar/index.tsx',
    bytes: 19762,
    hash: 'f35e4fd7b218110756bd04357c5b8c4bbb64be5012aefc7d7a7c1ab303d483ae',
  },
]

const routingAccessorCanonical: readonly CanonicalEntry[] = [
  {
    kind: 'dist',
    source: 'package/dist/routing-accessor/index.d.ts',
    output: 'routing-accessor/index.d.ts',
    bytes: 2486,
    hash: '8bc146aea3903fad91ece61f0022251e8a45086ac11afa86ce93ec7bb2c05436',
  },
  {
    kind: 'dist',
    source: 'package/dist/routing-accessor/index.js',
    output: 'routing-accessor/index.js',
    bytes: 4967,
    hash: 'ff1fb189de19874df1edf25a64425bad2ca23013a6e392ab3247138cdd57b240',
  },
]

function canonicalEntries(
  consumer: CommonAuthEmbeddingPackage,
): CanonicalEntry[] {
  return [
    ...canonical
      .filter(
        ([path]) =>
          consumer === 'opencode' ||
          !/^(?:rpc|tui|opencode2|setup)\//.test(path),
      )
      .map(
        ([output, bytes, hash]): CanonicalEntry => ({
          kind: 'dist',
          source: `package/dist/${output}`,
          output,
          bytes,
          hash,
        }),
      ),
    ...(consumer === 'opencode'
      ? [...sidebarCanonical, ...routingAccessorCanonical]
      : []),
  ]
}

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
  for (const [root, targets] of Object.entries(
    embeddingProfiles.opencode.publicRoots,
  )) {
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
    '77017404c8016f92d6fd7f658b1da29cfc835e790cb830ce56baf1943724baa4'
  )
    throw new Error('publication: inventory')
  for (const { source, output, bytes, hash } of canonicalEntries('opencode')) {
    const data = entries.get(source)
    if (!data || data.length !== bytes || sha256(data) !== hash)
      throw new Error(`publication: bytes ${output}`)
  }
  if (
    sha256(entries.get('package/package.json') ?? '') !==
    '9e3b35d140b7b532b1879020a5c1397c9a41ee3fdd43b1c7a43f06a4bb3fd4aa'
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
  const selected = canonicalEntries(consumer)
  const files = selected.map(({ source, output, bytes, hash }) => ({
    source,
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
      version: 4,
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
    `common-auth ${producerVersion} (${artifactStatus}): verified ${canonicalEntries('opencode').length} canonical files (${canonicalEntries('opencode').reduce((total, { bytes }) => total + bytes, 0)} bytes) and MIT notice`,
  )
}
