import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PreviewUpgradeStatus } from './PreviewUpgradeStatus';
const render = (queued:number, running:number, failed:number, waiting:number, enabled=true) => renderToStaticMarkup(<PreviewUpgradeStatus enabled={enabled} busy={false} dirty={false} onRetry={()=>{}} diagnostics={{sharedPhotos:7573,cacheBytes:0,conversionFailures:0,previews:{queued,running,failed,ready:1596,limited:1},previewStorage:{retryPending:waiting,usageBytes:0,limitMiB:64096,freeBytes:0,remaining:failed,suggestedMiB:null,failures:[]}}}/>);
it('says no action is needed when failures are already scheduled',()=>{
 const html=render(998,1,4977,4977);
 expect(html).toContain('No action needed');
 expect(html).toContain('1,597 of 7,573 processed');
 expect(html).toContain('max="7573"');
 expect(html).toContain('value="1597"');
 expect(html).not.toContain('<button');
 expect(html).not.toContain('Retry requested for 0');
});
it('shows action needed after retries finish with failures',()=>{
 const html=render(0,0,2,0);
 expect(html).toContain('Action needed');
 expect(html).toContain('Retry failed previews');
});
it('does not claim no action is needed when new failures occur',()=>{
 expect(render(10,1,4,2)).not.toContain('No action needed');
 expect(render(10,1,4,2)).toContain('need attention');
});
it('shows paused when sharing or upgrades are off, and complete when finished',()=>{
 expect(render(10,0,4,4,false)).toContain('paused');
 expect(render(0,0,0,0)).toContain('complete');
});
it('offers immediate pause and resume controls while retaining progress',()=>{
 const props={busy:false,dirty:true,onRetry:()=>{},onToggle:()=>{},diagnostics:{sharedPhotos:10,cacheBytes:0,conversionFailures:0,previews:{queued:9,running:1,ready:0,limited:0,failed:0}}};
 expect(renderToStaticMarkup(<PreviewUpgradeStatus {...props} enabled/>)).toContain('>Pause</button>');
 const paused=renderToStaticMarkup(<PreviewUpgradeStatus {...props} enabled={false}/>);
 expect(paused).toContain('>Resume</button>');
 expect(paused).not.toContain('disabled=');
 const off=renderToStaticMarkup(<PreviewUpgradeStatus {...props} enabled={false} canResume={false}/>);
 expect(off).toContain('Enable TV sharing');
 expect(off).not.toContain('>Resume</button>');
});
