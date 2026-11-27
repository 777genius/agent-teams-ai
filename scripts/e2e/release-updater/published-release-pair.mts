import assert from 'node:assert/strict';

import {
  assetByName,
  checkRelease,
  fileProof,
  older,
} from '../../ci/release/contract.ts';

import type { Release } from '../../ci/release/contract.ts';

export interface PublishedAssetPin {
  id: number;
  name: string;
  size: number;
  sha256: string;
}

interface ReleaseIdentity {
  id: number;
  tag: string;
  applicationSha: string;
}

export const published219Pair = {
  repository: '777genius/agent-teams-ai',
  predecessor: {
    id: 441935230,
    tag: 'v2.18.7',
    applicationSha: 'd317ceeb28e22d52d2b03e3b0bfa471e8fa6e2f1',
  },
  target: {
    id: 457537401,
    tag: 'v2.19.0',
    applicationSha: '2a4e1c2938923826cb1555e8fb894a3fdbb4447e',
  },
  predecessorAssets: [
    { id: 736220873, name: 'Agent.Teams.AI.Setup.2.18.7.exe', size: 391541219, sha256: 'be55353d24149c9d54f02e49e2f6ddbabad2c9f181553904dc92a31c0dfddff0' },
    { id: 736221662, name: 'Agent.Teams.AI.Setup.2.18.7.exe.blockmap', size: 392670, sha256: '4ddb692581594672a63ce1ea6d83a6fef3e1c4c538c1745feb680e6a8cd73615' },
    { id: 736264542, name: 'Agent.Teams.AI.Setup.2.18.7-arm64.exe', size: 374447700, sha256: 'faf8f38f71474eb0b6bd723479099e130dae763632cdf1dfbfde3ea8bc47859f' },
    { id: 736265234, name: 'Agent.Teams.AI.Setup.2.18.7-arm64.exe.blockmap', size: 375400, sha256: '32d3d83776fc488a759aa409804e7c6c4f164ead743003dc3498ab2490ec00e7' },
    { id: 736238433, name: 'Agent.Teams.AI-2.18.7.AppImage', size: 466746720, sha256: '528ac7e646a0b8c64bb76cbb5bac7e600efcb00aa1db153102612675e00fa5b2' },
    { id: 736239766, name: 'agent-teams-ai_2.18.7_amd64.deb', size: 360192864, sha256: '1d473dae109478b77debec7372aeca813d6c2abbb9dc0f8cc514373b8f25b4d7' },
    { id: 736240879, name: 'agent-teams-ai-2.18.7.x86_64.rpm', size: 303618177, sha256: '2cc138936edc56e32b9a6438bf3fa6fcae20629f5608fa4531be4c5dc0b3f7e2' },
    { id: 736242006, name: 'agent-teams-ai-2.18.7.pacman', size: 320293108, sha256: 'f4679917afc112432db9ae9c841b7ddb0aabe2fe829d87086b9c4684b9e6d37c' },
    { id: 736198242, name: 'Agent.Teams.AI-2.18.7-arm64-mac.zip', size: 459970237, sha256: 'c00528592565860aeabfab00f2b1dbd5524969089f7a95fcb21a19fb78880010' },
    { id: 736198921, name: 'Agent.Teams.AI-2.18.7-arm64-mac.zip.blockmap', size: 470968, sha256: 'b0d6fbc651382b3d171e8b6201e5b1ef1cdd6a3bce40f388dad066c87518515e' },
    { id: 736197586, name: 'Agent.Teams.AI-2.18.7-arm64.dmg', size: 478712561, sha256: '5855a7a532947e93391bb33b429df944f5614da8b4e6207d67cc3662ed3a0c2f' },
    { id: 736198958, name: 'Agent.Teams.AI-2.18.7-arm64.dmg.blockmap', size: 498559, sha256: '867b4684a1a257a7f12c38974277520874284bcbf55ba4c0c3743baab702939b' },
    { id: 736297945, name: 'Agent.Teams.AI-2.18.7-x64-mac.zip', size: 474992764, sha256: '7c7a47cc7be73deca55dc3f299f43b914093e0d9179ee5f55c4dc08bb3bf6367' },
    { id: 736299189, name: 'Agent.Teams.AI-2.18.7-x64-mac.zip.blockmap', size: 486249, sha256: '7031d127f3257b291c94c4ff4293cca9b1d760c584cd2ae13ebfe4ab3b187170' },
    { id: 736296421, name: 'Agent.Teams.AI-2.18.7-x64.dmg', size: 493690573, sha256: '12474017a96812b10f6388973ceeb0d09f48ec9abab184fa09fd11722ff87bd3' },
    { id: 736299278, name: 'Agent.Teams.AI-2.18.7-x64.dmg.blockmap', size: 514433, sha256: '395b0706056801aee5210b5a013fd84ed7f3cf8b1fad126aab26204cd696e560' },
    { id: 736708417, name: 'latest.yml', size: 5808, sha256: 'fe8a01c2077448b9077a7e1a87d89e081f3aa884f9c2d463ec9f4d3ca0393363' },
    { id: 736708415, name: 'latest-mac.yml', size: 6163, sha256: '2e98ebec3b771873fcaf6b06f8b1c5435bf913f1a0621b335b8eb3bdd22ac667' },
    { id: 736708416, name: 'latest-linux.yml', size: 6122, sha256: 'e0b249061d98e2383c863a867d83b58e3a5aa63304482e16b5bc63e9b2826cab' },
  ] satisfies readonly PublishedAssetPin[],
  targetAssets: [
    { id: 790264978, name: 'Agent.Teams.AI.Setup.2.19.0.exe', size: 392296243, sha256: 'd8f6f76ab436cfae2f04cf64f218c588b189b833369cd1b38c33e427f4ac51de' },
    { id: 790265764, name: 'Agent.Teams.AI.Setup.2.19.0.exe.blockmap', size: 394129, sha256: 'bf622bfc68c559b8d211c96f3ce525c6b6287213bada5ea297cf126e5ff2ef08' },
    { id: 790067715, name: 'Agent.Teams.AI.Setup.2.19.0-arm64.exe', size: 375161044, sha256: 'dfcdf1b23952722d84087f955313b22775ece8efbc83b3f649f8a75f81cb1b44' },
    { id: 790068289, name: 'Agent.Teams.AI.Setup.2.19.0-arm64.exe.blockmap', size: 376818, sha256: '5975af686fa492e5f91129e2c0e3a987ab1ae13d5588aa75a6da505792af9f89' },
    { id: 790289664, name: 'Agent.Teams.AI-2.19.0.AppImage', size: 467906548, sha256: '718a4aa2dfadf02acc1610023ab423d733c6d41a5747e26e23497696757e2855' },
    { id: 790292094, name: 'agent-teams-ai_2.19.0_amd64.deb', size: 360740388, sha256: '8b3a9def021c7f4d6301ba1ca7040e3e0e057faab31e12ccd8802d3984f29ef9' },
    { id: 790292726, name: 'agent-teams-ai-2.19.0.x86_64.rpm', size: 304282225, sha256: '318daedb23d6af9710cdef8be788d57adaf0d22addce34a716ed57603f34eaee' },
    { id: 790293333, name: 'agent-teams-ai-2.19.0.pacman', size: 322243812, sha256: '7bac8278a6048a0170f8c37053bb4098b8b15940f292e5a60d04441000c5bfa6' },
    { id: 790174875, name: 'Agent.Teams.AI-2.19.0-arm64-mac.zip', size: 460670720, sha256: '9ffa887dbd187cc285705d358649995fb9dbc7fa231629066bbf6d268d4e00be' },
    { id: 790175815, name: 'Agent.Teams.AI-2.19.0-arm64-mac.zip.blockmap', size: 470622, sha256: '22aeec048625694c802e4d6578449981b7997c42a1c1ad2f88e49efacb69d611' },
    { id: 790173838, name: 'Agent.Teams.AI-2.19.0-arm64.dmg', size: 479416383, sha256: 'f3acc40f932beca59b3146cdd88e2509c76c55f6fbd33da5efe07182bbc5f380' },
    { id: 790175862, name: 'Agent.Teams.AI-2.19.0-arm64.dmg.blockmap', size: 499377, sha256: 'f6b7ea6f4f420f17311bdea8f99f1a8ce15a4f7dbeb6c9ff592a7eefb15bb556' },
    { id: 790178874, name: 'Agent.Teams.AI-2.19.0-x64-mac.zip', size: 475673904, sha256: 'ac4937d4e341d1b2700c1827bdfd6032630bdff1a6d7795c1fe5ea0c4424cfb3' },
    { id: 790180251, name: 'Agent.Teams.AI-2.19.0-x64-mac.zip.blockmap', size: 486497, sha256: '042bbbd4c832eed40261db9c85f4dedae99a4f5d6b2b05bba08e8348a9e27458' },
    { id: 790177878, name: 'Agent.Teams.AI-2.19.0-x64.dmg', size: 494415900, sha256: '04c12a0ebc26cc884f8b441900c7a69a38c7f5c0e03c103c5bcf43598074112d' },
    { id: 790180304, name: 'Agent.Teams.AI-2.19.0-x64.dmg.blockmap', size: 517305, sha256: 'c125c3ff4079e0be45f5a3d9601725ee4c5bdb267e3bd54928350cebe955c822' },
    { id: 791357873, name: 'latest.yml', size: 13430, sha256: '6d2eeeba86f43ec937887dea398448ad2a4342ae6816096c76f0b81b021791fe' },
    { id: 791357962, name: 'latest-mac.yml', size: 13785, sha256: 'e15365188d949c690d76c301c14b9f7ea7d9e8310ebb16f722e7781061b425f5' },
    { id: 791357911, name: 'latest-linux.yml', size: 13744, sha256: '4e016a4ae97e4cc963a4feb42a3f3005aac31a1663ccea9f6c22defd121da17e' },
  ] satisfies readonly PublishedAssetPin[],
} as const;

function validateAssets(release: Release, pins: readonly PublishedAssetPin[]) {
  assert.equal(new Set(pins.map((pin) => pin.name)).size, pins.length, 'Unique pinned asset names');
  assert.equal(new Set(pins.map((pin) => pin.id)).size, pins.length, 'Unique pinned asset IDs');
  for (const pin of pins) {
    const asset = assetByName(release, pin.name);
    assert.equal(asset.id, pin.id, release.tag_name + '/' + pin.name + ': asset ID');
    assert.equal(asset.size, pin.size, release.tag_name + '/' + pin.name + ': size');
    assert.equal(asset.digest, 'sha256:' + pin.sha256, release.tag_name + '/' + pin.name + ': SHA-256');
  }
}

function validateRelease(release: Release, identity: ReleaseIdentity, pins: readonly PublishedAssetPin[]) {
  checkRelease(release, undefined, false);
  assert.equal(release.id, identity.id, identity.tag + ': release ID');
  assert.equal(release.tag_name, identity.tag, 'Exact release tag');
  assert.equal(release.target_commitish, identity.applicationSha, identity.tag + ': target commit');
  validateAssets(release, pins);
}

export function verifyPublished219Pair(
  predecessor: Release,
  target: Release,
  latest: Release,
  predecessorTagSha: string,
  targetTagSha: string
) {
  validateRelease(predecessor, published219Pair.predecessor, published219Pair.predecessorAssets);
  validateRelease(target, published219Pair.target, published219Pair.targetAssets);
  assert.equal(predecessorTagSha, published219Pair.predecessor.applicationSha, 'Predecessor tag commit');
  assert.equal(targetTagSha, published219Pair.target.applicationSha, 'Target tag commit');
  checkRelease(latest, undefined, false);
  assert.equal(latest.id, target.id, 'GitHub latest release ID');
  assert.equal(latest.tag_name, target.tag_name, 'GitHub latest release tag');
  assert.equal(latest.target_commitish, target.target_commitish, 'GitHub latest target commit');
  validateAssets(latest, published219Pair.targetAssets);
  assert(older(predecessor.tag_name, target.tag_name), 'Target must be newer than predecessor');
  return {
    repository: published219Pair.repository,
    predecessor: { ...published219Pair.predecessor },
    target: { ...published219Pair.target },
    predecessorAssetCount: published219Pair.predecessorAssets.length,
    targetAssetCount: published219Pair.targetAssets.length,
  };
}

export async function verifyPublishedAssetBytes(file: string, pin: PublishedAssetPin) {
  const proof = await fileProof(file, pin.name);
  assert.equal(proof.size, pin.size, pin.name + ': downloaded size');
  assert.equal(proof.sha256, pin.sha256, pin.name + ': downloaded SHA-256');
  return proof;
}

export function published219Asset(tag: 'v2.18.7' | 'v2.19.0', name: string) {
  const pins = tag === 'v2.18.7' ? published219Pair.predecessorAssets : published219Pair.targetAssets;
  const pin = pins.find((item) => item.name === name);
  assert(pin, 'No exact ' + tag + ' asset pin for ' + name);
  return pin;
}
