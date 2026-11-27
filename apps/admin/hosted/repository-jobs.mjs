import {createRemoteJWKSet,jwtVerify} from "jose";
import {PanelError} from "../errors.mjs";
import {boundedJson} from "./http.mjs";

const repo="afrotc-det225/shamrock-staging-runner";
const issuer="https://token.actions.githubusercontent.com";
const keys=createRemoteJWKSet(new URL(issuer+"/.well-known/jwks"));
const audience="shamrock-staging-repository-tests";
const day=86400000;
const prefix="repository-test/";
const uuid=/^[0-9a-f-]{36}$/;
export function runnerIdentity(claims){
  if(claims.repository_id!=="1473995318" || claims.repository_owner_id!=="261806974" ||
     claims.workflow_ref!==repo+"/.github/workflows/check.yml@refs/heads/main" ||
     claims.ref!=="refs/heads/main" || !["schedule","workflow_dispatch"].includes(claims.event_name) ||
     !/^\d+$/.test(claims.run_id) || !/^\d+$/.test(claims.run_attempt))throw new Error("Unexpected runner");
  return claims.run_id+"/"+claims.run_attempt;
}
export async function runnerOperation(request,operation){
  try{
    const token=request.headers.get("authorization")?.match(/^Bearer ([\w.-]+)$/)?.[1];
    const {payload}=await jwtVerify(token,keys,{issuer,audience,algorithms:["RS256"]});
    const run=runnerIdentity(payload);
    if(operation==="claim")return {operation,run};
    const {id,passed}=await boundedJson(request,256);
    if(!uuid.test(id) || typeof passed!=="boolean")throw new Error();
    return {operation,run,id,passed};
  }catch{throw new PanelError("FORBIDDEN","Invalid staging runner identity or result.",403);}
}
export async function repositoryJob(storage,input,now){
  return storage.transaction(async tx=>{
    const {operation,id,run}=input;
    const records=await tx.list({prefix});
    const jobs=[];
    for(const [key,job] of records){
      if(now-job.at>7*day){await tx.delete(key);continue;}
      if(["running","publishing"].includes(job.state) && now-job.started>35*60000 || job.state==="queued" && now-job.at>day){
        job.state="expired";await tx.put(key,job);
      }
      jobs.push(job);
    }
    if(operation==="create"){
      if(jobs.filter(j=>now-j.at<day).length>=20)return null;
      const job={id,at:now,state:"queued",patch:input.patch};
      await tx.put(prefix+id,job);return id;
    }
    if(operation==="claim"){
      const job=jobs.find(j=>["running","publishing"].includes(j.state) && j.run===run) ?? jobs.find(j=>["queued","approved"].includes(j.state));
      if(!job)return null;
      if(["queued","approved"].includes(job.state)){
        Object.assign(job,{run,state:job.state==="approved"?"publishing":"running",started:now});await tx.put(prefix+job.id,job);
      }
      return {id:job.id,patch:job.patch,operation:job.state==="publishing"?"publish":"test"};
    }
    const job=jobs.find(j=>j.id===id);
    if(!job)return null;
    if(operation==="approve" && job.state==="passed" && job.patch){
      job.state="approved";await tx.put(prefix+id,job);
    }
    if(operation==="finish" && job.run===run && job.state==="publishing"){
      job.state=input.passed?"published":"passed";await tx.put(prefix+id,job);
    }else if(operation==="finish" && job.run===run && job.state==="running"){
      job.state=input.passed?"passed":"failed";if(!input.passed)delete job.patch;await tx.put(prefix+id,job);
    }
    return {state:job.state};
  });
}
export async function wakeRunner(env){
  if(!env.STAGING_RUNNER_DISPATCH)return;
  try{
    await fetch("https://api.github.com/repos/"+repo+"/actions/workflows/check.yml/dispatches",{
      method:"POST",redirect:"error",signal:AbortSignal.timeout(5000),headers:{
        authorization:"Bearer "+env.STAGING_RUNNER_DISPATCH,"user-agent":"SHAMROCK-staging",
        "content-type":"application/json"},body:JSON.stringify({ref:"main"})});
  }catch{ /* Scheduled pickup also handles dispatch outages. */ }
}
