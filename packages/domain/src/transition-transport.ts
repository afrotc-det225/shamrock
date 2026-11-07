import { assembleFrontendSnapshotPages,type FrontendDataPage,type FrontendPageManifest,type FrontendVerifyPage } from './frontend-transport.js';
import type { FrontendSnapshot } from './admin.js';
export const TRANSITION_SNAPSHOT_PAGE_VERSION='transition-snapshot-pages-v1' as const;
export interface TransitionSnapshotDescriptor {
  contractVersion:typeof TRANSITION_SNAPSHOT_PAGE_VERSION;manifest:FrontendPageManifest;verify:FrontendVerifyPage;
  pages:{sequence:number;section:string;offset:number;sha256:string;bytes:number}[];
}
/** The descriptor hash is not the assembled snapshot hash. Verify both at their own boundaries. */
export function assembleTransitionSnapshot(descriptor:TransitionSnapshotDescriptor,pages:FrontendDataPage[],descriptorHash:string,sha256:(text:string)=>string):{snapshot:FrontendSnapshot;assembledSnapshotHash:string} {
  const check=(value:unknown)=>{if(!value)throw new Error('INVALID_TRANSITION_SNAPSHOT_PAGES');};
  check(descriptor?.contractVersion===TRANSITION_SNAPSHOT_PAGE_VERSION&&/^[a-f0-9]{64}$/.test(descriptorHash)&&sha256(JSON.stringify(descriptor))===descriptorHash);
  check(Array.isArray(descriptor.pages)&&descriptor.pages.length<=512&&pages.length===descriptor.pages.length);
  for(const [i,p]of pages.entries()){const expected=descriptor.pages[i];check(expected.sequence===i&&expected.section===p.section&&expected.offset===p.offset&&sha256(JSON.stringify(p))===expected.sha256&&Number.isSafeInteger(expected.bytes)&&expected.bytes>0&&expected.bytes<=128000);}
  const snapshot=assembleFrontendSnapshotPages(descriptor.manifest,pages,descriptor.verify);return {snapshot,assembledSnapshotHash:sha256(JSON.stringify(snapshot))};
}
