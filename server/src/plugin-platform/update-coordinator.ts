import fs from "node:fs";
import path from "node:path";
import type { KeyLike } from "node:crypto";
import { PluginCatalogLoader } from "./catalog-loader.js";
import type { PluginManager } from "./manager.js";

export interface PluginUpdateRecord { pluginId:string; fromVersion:string|null; toVersion:string; status:"installed"|"rolled-back"|"failed"; at:string; error?:string; }

export class PluginUpdateCoordinator {
  private timer?:NodeJS.Timeout;
  private retryTimer?:NodeJS.Timeout;
  private running=false;
  private readonly historyPath:string;
  constructor(private manager:PluginManager,private options:{catalogUrl:string;publicKey:KeyLike;allowHttp?:boolean;rootDir:string;canActivate:()=>boolean;intervalMs?:number}){this.historyPath=path.join(options.rootDir,"update-history.json");}
  start():void{this.timer=setInterval(()=>void this.checkNow(),this.options.intervalMs??86_400_000);this.timer.unref();}
  stop():void{if(this.timer)clearInterval(this.timer);if(this.retryTimer)clearTimeout(this.retryTimer);}
  history():PluginUpdateRecord[]{try{return JSON.parse(fs.readFileSync(this.historyPath,"utf8")) as PluginUpdateRecord[];}catch{return[];}}
  async checkNow():Promise<{updated:number;available:number}>{
    if(this.running)return{updated:0,available:this.manager.availableUpdates().length};this.running=true;
    try{
      const catalog=await new PluginCatalogLoader({publicKey:this.options.publicKey,allowHttp:this.options.allowHttp}).load(this.options.catalogUrl);this.manager.setCatalog(catalog);
      const updates=this.manager.availableUpdates();let updated=0;
      for(const update of updates){if(this.manager.isBusy())break;const before=this.manager.state.snapshot().plugins[update.id]?.activeVersion??null;
        try{if(!this.manager.state.snapshot().plugins[update.id]?.installedVersions.includes(update.version))await this.manager.installFromCatalog(update.id,update.version,this.options.catalogUrl);if(!this.options.canActivate())continue;await this.manager.activateInstalledUpdate(update.id,update.version);this.record({pluginId:update.id,fromVersion:before,toVersion:update.version,status:"installed",at:new Date().toISOString()});updated++;}
        catch(error){this.record({pluginId:update.id,fromVersion:before,toVersion:update.version,status:before?"rolled-back":"failed",at:new Date().toISOString(),error:error instanceof Error?error.message:String(error)});}
      }
      if(updated<updates.length&&!this.retryTimer){this.retryTimer=setTimeout(()=>{this.retryTimer=undefined;void this.checkNow().catch(()=>{});},300_000);this.retryTimer.unref();}
      return{updated,available:updates.length};
    }finally{this.running=false;}
  }
  private record(item:PluginUpdateRecord):void{const history=[...this.history(),item].slice(-200),temporary=`${this.historyPath}.tmp`;fs.writeFileSync(temporary,`${JSON.stringify(history,null,2)}\n`);fs.rmSync(this.historyPath,{force:true});fs.renameSync(temporary,this.historyPath);}
}
