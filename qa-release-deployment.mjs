import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

// Read-only product assessment. All git/docker/curl/sleep calls inside the real
// deployment script are shell functions; no repository or container is changed.
const directory=resolve('data-qa-release-deployment',String(Date.now()));
mkdirSync(directory,{recursive:true});
const script=resolve('scripts/nas/auto-update.sh').replaceAll('\\','/');
const shell=process.env.QA_BASH || 'C:/Program Files/Git/bin/bash.exe';
const oldRevision='1111111111111111111111111111111111111111';
const newRevision='2222222222222222222222222222222222222222';
const harness=String.raw`
git() {
  case "$1" in
    fetch) return 0 ;;
    rev-parse)
      if [ "$2" = "--short" ]; then printf '2222222\n';
      elif [ "$2" = "HEAD" ]; then printf '%s\n' "$QA_FAKE_HEAD";
      else printf '%s\n' "$QA_REMOTE_REV"; fi ;;
    reset) printf 'QA_EVENT=RESET_TO_NEW\n'; QA_FAKE_HEAD="$QA_REMOTE_REV"; return 0 ;;
    log) printf '2222222 synthetic deployment candidate\n' ;;
    *) printf 'Unexpected git stub command\n' >&2; return 97 ;;
  esac
}
docker() {
  if [ "$1" = "compose" ] && [ "$2" = "version" ]; then return 0; fi
  if [ "$1" = "compose" ] && [ "$2" = "up" ]; then
    printf 'QA_EVENT=COMPOSE_UP\n'
    if [ "$QA_CASE" = "build-failure" ]; then return 1; fi
    return 0
  fi
  printf 'Unexpected docker stub command\n' >&2; return 98
}
docker-compose() { printf 'Unexpected fallback\n' >&2; return 98; }
curl() { printf 'QA_EVENT=HEALTH_FAILURE\n'; return 1; }
sleep() { return 0; }
source "$QA_TARGET"
`;
const results=[];
for(const scenario of ['build-failure','unhealthy-after-deploy']) {
  const fixture=join(directory,scenario);mkdirSync(fixture,{recursive:true});
  const env={...process.env,PROJECT_DIR:fixture.replaceAll('\\','/'),QA_TARGET:script,
    QA_REMOTE_REV:newRevision,QA_CASE:scenario,QA_FAKE_HEAD:oldRevision};
  const first=spawnSync(shell,['--noprofile','--norc','-c',harness],{env,encoding:'utf8',timeout:20000});
  assert.equal(first.status,1,`initial ${scenario} must fail`);
  assert.match(first.stdout,/QA_EVENT=RESET_TO_NEW/);
  const logBefore=readFileSync(join(fixture,'auto-update.log'),'utf8');
  assert.match(logBefore,/QA_EVENT=COMPOSE_UP/);
  const second=spawnSync(shell,['--noprofile','--norc','-c',harness],{
    env:{...env,QA_FAKE_HEAD:newRevision},encoding:'utf8',timeout:20000});
  assert.equal(second.status,0,'next scheduled run reports success/no change');
  const logAfter=readFileSync(join(fixture,'auto-update.log'),'utf8');
  assert.equal(logAfter,logBefore,'next run neither builds nor checks service health');
  results.push({scenario,firstExit:first.status,secondExit:second.status,
    repositoryAdvancedBeforeSuccess:true,nextRunRetries:false,nextRunChecksHealth:false,
    automaticRollbackObserved:false,method:'Actual auto-update.sh sourced with fake git/docker/curl/sleep functions',
    evidence:join(fixture,'auto-update.log')});
}
const report={at:new Date().toISOString(),scope:'isolated deployment control-flow probes; no actual Git, Docker, NAS or network mutations',results};
writeFileSync(join(directory,'results.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({directory,...report},null,2));
