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
  'tools/common-auth-build/inputs/cortexkit-common-auth-0.11.6.tgz'
export const producerVersion = '0.11.6'
export const artifactStatus = 'released'
export const outputPath = 'packages/opencode/src/common-auth-embedded'
export const productionPin = Object.freeze({
  sha256: '2e1cbbdd2c5e75bbeecada6a64b93c29b64c5d3b41d3742312e1390cfaa6d9df',
  sri: 'sha512-WAgd5JyiGK++frdMWkOzSWzziWvjspp2sq4NZJwFJycBiBET3juAlEiyeZpl462dyO22U/ECDKCHOMg+xu5ZMA==',
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
    },
  },
} as const
export type CommonAuthEmbeddingPackage = keyof typeof embeddingProfiles

// The expected publication hashes are fixed constants, not computed from an existing output tree.
const canonical: readonly (readonly [string, number, string])[] = [
  [
    'auth-menu/accounts.d.ts',
    4800,
    'b107330a91ee49899c05ca620999a2900e5bb9f59f1e103c0714e920d0bf3c92',
  ],
  [
    'auth-menu/accounts.js',
    15562,
    '06295d98dd6720b2ae6925bf3181dedae6067c4e1aa14325e74593d1ff7f5366',
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
    1980,
    'faf5ffe70a0187b9a3451faae4fdb49474acd66b2e7b620c389c2111f3dc4033',
  ],
  [
    'auth-menu/login.js',
    2166,
    'a3674a8bc6f19bb737d5a728182573a5ec23af3f9714f7e83d3e94eeb414e74c',
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
    'claustrum/consumer.d.ts',
    5064,
    '8be8fd17170daddc8ad93a78fe33334358eb4fe717f55b8acfff880122bb9609',
  ],
  [
    'claustrum/consumer.js',
    11915,
    'b616be70b61f7ba90262759d51aed31a8f71abf54a6484b0740dfdf6d2458623',
  ],
  [
    'claustrum/custody.d.ts',
    8713,
    '46ddac6c6641853dac313b7ddda106037a5b9fd512da5244c2767bfc0345536d',
  ],
  [
    'claustrum/custody.js',
    15071,
    '8dae16f4afc9f39855e84a340a224d77d663d42ce53a0b425d2427d0e2f0eff0',
  ],
  [
    'claustrum/enrollment.d.ts',
    5516,
    '3968bc66ce52a6affb6553342f5688fb8c830e08a43ef9c5ed1156f5e87a1feb',
  ],
  [
    'claustrum/enrollment.js',
    26529,
    '60cb355ebec28c3d750d6cdfe685071437a5b43f3c1b9b6e0fa11e0570c10d46',
  ],
  [
    'claustrum/errors.d.ts',
    1095,
    'ba3dbd69b13c521944bd700b063afaaced9a1312bbfbfcebb8ae8b4f3785c52a',
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
    2641,
    'c21d5776b641faa79cff179154894ecd836774ec66264ee1f7e043ee4b085ed2',
  ],
  [
    'claustrum/index.js',
    1915,
    '2a746e9fca574b0378dfbd562567b94c8efad2be8a4e7b4ad198ef0d6d6c6b6a',
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
    9312,
    '45a63920ad5998b68b1bcba9a2208e7adab99cb1999df55d798b0a2b088d7d39',
  ],
  [
    'claustrum/roster.js',
    23786,
    '508fed4aed11daef7cb407089c3c8e739aec6c0b29a9922cdcd7a010e8af0b63',
  ],
  [
    'commands/builtins.d.ts',
    2931,
    'b70028ea58b51d344e83ac62f36fa95499ab32af753e657ade8116491488bab9',
  ],
  [
    'commands/builtins.js',
    20188,
    'd373de792dd0022d1cad8eee862f133c30a189554bfa34a2c2dc07147d29a0ec',
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
    5982,
    '6bed9fe5bdd19bb33c05140a1389b10501c03a0767e2f9dd01ef91dca3386819',
  ],
  [
    'commands/model.js',
    664,
    'ec1ddeedfda381d54ef3a6f3a2ade25622efd03233ead2545dbcab860ff024b7',
  ],
  [
    'commands/pi.d.ts',
    987,
    '6893bfe1a9a48fc5efe4ce5a54d9a0a56df699402afc01ac544fbbd8ee757090',
  ],
  [
    'commands/pi.js',
    7035,
    '16680cefa027a8209977bed69be0e11299538c3068bcd95e5c202fa37d4021c4',
  ],
  [
    'commands/seam.d.ts',
    3433,
    'bae574e565f9ccdc6ead34f959009e85c2a8f770cbd2ae152ec30e93b294e0b1',
  ],
  [
    'commands/seam.js',
    11091,
    '0396a515b98c5aa10299fbaaffdfd8a47e8ee80fdc8f95e9bcce9337db66f3b7',
  ],
  [
    'fs/atomic-write.d.ts',
    352,
    'b0f665f17e8e03bcb4a14c627990039686395ca259aabe2f8b26fca988c165a4',
  ],
  [
    'fs/atomic-write.js',
    1060,
    '1b8939573dad2eb2ed9562e5880fc8f8ff9b19e7f5f17df026210600ff0ee7e4',
  ],
  [
    'fs/index.d.ts',
    508,
    '69344577a9fd8efdac1cbb83d8e3e21ca7f09645623f2f35a22b3cf3ba914edd',
  ],
  [
    'fs/index.js',
    454,
    '27412caa40574b195c48045d60c32880d0906109e1101bc1b6447118a2d48b14',
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
    'fs/refresh-file-lock.d.ts',
    1701,
    '55473d70c407f4521eb285c2f44b1398391fc56326914c0e51bf7fbea2518781',
  ],
  [
    'fs/refresh-file-lock.js',
    19961,
    'e621abceca8fb963aa4851aa456309ed3014ff9c0fb5e3250ede6423b9f35222',
  ],
  [
    'fs/with-lock.d.ts',
    934,
    'a505c744baef71ad72a62c806db60ab052f97687a7e28d11e69411f969848a37',
  ],
  [
    'fs/with-lock.js',
    1507,
    '284251aa245860f2ca64cfbdae0bfbbceed77f33950650cf5eafa1a6ed896387',
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
    4607,
    '646d7438df2aa50853dc8f8220236cee75e480342545d8d94718ea34259ae522',
  ],
  [
    'logger/engine.js',
    7925,
    '3ebcd0e8ad5aca437cee85e4b9087ba15d7efbcb07b5fefff937092f2de3f829',
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
    'quota/codec.d.ts',
    451,
    '35ceda009b4be9d0bcb7969d03d42225efb15fcc4e9df1a928a2a9c98aada5f4',
  ],
  [
    'quota/codec.js',
    447,
    '71a07337a0403c12541cc5125b4923c03c17a07e9fafe311d52d14ef2a5b2701',
  ],
  [
    'quota/index.d.ts',
    750,
    '1de7e579405b6c872463560006cc4b9c8636dda5dd36b90d784f2aa507c30ec2',
  ],
  [
    'quota/index.js',
    326,
    '8c8423f5601dea749ccb45c3143143a1a7e71a6281088650756f29eebff5bfe6',
  ],
  [
    'quota/map.d.ts',
    2270,
    'a2f7370148018247eae306b830ca824a2941aa53ece71cf301063a67ba9eb4a1',
  ],
  [
    'quota/map.js',
    4271,
    '61fb25c789389e57ff8cceb450f6872c2b6e4961cec3c4650f6af699ab5a27f2',
  ],
  [
    'quota/merge.d.ts',
    1628,
    '88998476cd9de8037577065098894fd2ab4b5faed3f07edf5ac35b8f5bf6bcc1',
  ],
  [
    'quota/merge.js',
    6513,
    'c21d7490b7ced3f646e94069d4de2e15b97231a96b3227b03c3a3197738359ad',
  ],
  [
    'quota/projection.d.ts',
    2911,
    'e410a8db0ff2ae805dbe342088d08ab555a701466159479f2e838f585b820c92',
  ],
  [
    'quota/projection.js',
    5509,
    '1fd24078f42e7658c31c31f08116f96bf7b53b91948650deefca9a4add481d76',
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
    7580,
    '8f22d1e16000b0fabae9e4d5478366e8caae4ac0daf40ff1b1e303fb8f006226',
  ],
  [
    'rpc/rpc-client.d.ts',
    1719,
    'c51f2fb15e862f948c044a83790a9395f4e0638ff0e587bafa7b4a840fccdd62',
  ],
  [
    'rpc/rpc-client.js',
    11226,
    '63b056613db32bc8d6f2438e6437c82bab3c29ea5f616f251966b793ce40604c',
  ],
  [
    'rpc/rpc-server.d.ts',
    2676,
    'cd60d433c1d0d763544b7ee5c78f905bfffb332bc2622586971b90f8e37dc27d',
  ],
  [
    'rpc/rpc-server.js',
    13540,
    'd431feb3556e684ae0539e8818391dcf64028f3e4b12fe7a1d2b391a430d843d',
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
    'store/attribution.d.ts',
    1528,
    '441dba300556a927e872597c1df3e4fbb1ac61c0a3989e98dcd3a94a773b8ed7',
  ],
  [
    'store/attribution.js',
    2844,
    'ca31b567881d9a062bd4b2d92c765a02f8b3e5581e0fc6bfd49d98068e8c17f2',
  ],
  [
    'store/errors.d.ts',
    3040,
    'ebdcf0c35a455c639a592c33b92b0ec6b1f784523259b8789372103e7bad495f',
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
    2877,
    '859ac5db4ba66c224564ea3f1f5af3e52ef0911e174a436493b6e788c740b03a',
  ],
  [
    'store/index.d.ts',
    1905,
    '60d1751bdeb2bb0b651c907eafb13f751df1e7cba14d9123bad8c6863f1c9f23',
  ],
  [
    'store/index.js',
    534,
    'ec9782b6e92e9fb2fe3b17b13d5dbbed0792c30cd0f04b84c1cdaa642f785db8',
  ],
  [
    'store/mutate.d.ts',
    8183,
    '3c05cfb1120d3348cdb1cd2c8e4d0a29aabd9827cb12748d980f921618237622',
  ],
  [
    'store/mutate.js',
    15588,
    '16cd1d3f50d137067822364a10339a042f2bc2dc9d87996c77dce05ab1be2a03',
  ],
  [
    'store/pool.d.ts',
    10223,
    '23b1f74d5e0e6359ff19e441796c4c61d9bd0102fbd8a0531d1399651cce2d24',
  ],
  [
    'store/pool.js',
    5295,
    'b251c0bd476d2ccee2e9c098b3c237e029da9fdffe595dd513c3c45b0d7a3dc3',
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
    'store/pull.d.ts',
    1626,
    'd37421210e6e339d3a4166933257588431ce2f83a0d23bc6d5da4deeca7dabb4',
  ],
  [
    'store/pull.js',
    5146,
    '9e647b6a1fbe2e2d0a59bd5e015c0d4f5bf51ccd4074c61503166689ec40381c',
  ],
  [
    'store/refresh-lock.d.ts',
    2318,
    '04d05f036f5bd460cf29511957aa86ba39cd914db2bee2262d2a19e240ac7387',
  ],
  [
    'store/refresh-lock.js',
    4471,
    '94b6397ae32b38329058d536c3e0e4d113b5730d14c56ae025ada91bb8919617',
  ],
  [
    'store/refresh.d.ts',
    2996,
    'c0ac1dcfd2393ac0683f4f4503a0b732ff35d621768a9fe6c3c69e05e43aa35c',
  ],
  [
    'store/refresh.js',
    10543,
    '49bbeedcbade841264bb5c523348f54353a84838bca38c11eca29bd4182fbeb9',
  ],
  [
    'store/rows.d.ts',
    12442,
    '9d7a4cc67b985347395a0c28b63452dfccaf9cdbafef24916685229db9d99c45',
  ],
  [
    'store/rows.js',
    45272,
    '3bfad3785ba60a2d132aec0e53f3593e5036f11dde6cc6b9ca98f6249cbf8461',
  ],
  [
    'store/runtime.d.ts',
    1949,
    '6838abdf1de68578c8403f76d3404a86e0d286c28a99ff32cb8bd84544a718cb',
  ],
  [
    'store/runtime.js',
    2180,
    '499e00d2a46e46f3daf0619e4b06668fc2e4e604e1d74fcba7c14ac03e301be6',
  ],
  [
    'store/schema.d.ts',
    21477,
    '2cee4ecb1c3974aae8a72018ada22f9c985e589c5ece6ed73d2e781cce10794b',
  ],
  [
    'store/schema.js',
    29242,
    'f2f3d8e1be28e3dd038c15b4093a794fa890b752963f3e524883544b969849f0',
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
    14694,
    '27aca7f7e1994dc238fd696a84ea88b28ee6fdedc10affd87c0a5f3a7a74466e',
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
    'cf6914e4de5bb2628779090c554c73747e8a19ddbd7ccec073b39a8d6723ac73'
  )
    throw new Error('publication: inventory')
  for (const [path, bytes, hash] of canonical) {
    const data = entries.get(`package/dist/${path}`)
    if (!data || data.length !== bytes || sha256(data) !== hash)
      throw new Error(`publication: bytes ${path}`)
  }
  if (
    sha256(entries.get('package/package.json') ?? '') !==
    '6dd4828f04f3643c1b73079ba25dcbf196ad5f1981ae208116303461ad9adf38'
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
    ([path]) => consumer === 'opencode' || !/^(?:rpc|tui)\//.test(path),
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
    `common-auth ${producerVersion} (${artifactStatus}): verified 134 canonical files (648487 bytes) and MIT notice`,
  )
}
