import assert from 'node:assert/strict';
import test from 'node:test';
import {directoryLeadershipRole} from '../../.build/v3/packages/domain/src/admin.js';
test('Directory-derived Leadership includes only the supported operational commander roles',()=>{
  for(const role of ['Mission Support Squadron Commander','Blue Deputy Squadron Commander','Abroad Squadron Commander','Assistant Wing Deputy Commander']) assert.equal(directoryLeadershipRole(role,'Alpha','Blue'),null,role);
  assert.equal(directoryLeadershipRole('Squadron Commander','Alpha','Blue'),'Blue Squadron Commander');
  assert.equal(directoryLeadershipRole('Squadron Commander','Abroad','Abroad'),null);
  for(const role of ['Gold Squadron Commander','Cadet Wing Commander','Deputy Wing Commander','Operations Group Deputy Commander','Senior GMC Advisor','Deputy GMC Advisor']) assert.equal(directoryLeadershipRole(role,'Alpha','Blue'),role);
  assert.equal(directoryLeadershipRole('Flight Commander','Golf','Blue'),'Golf Flight Commander');
  assert.equal(directoryLeadershipRole('Golf Flight Commander','Golf','Blue'),'Golf Flight Commander');
  assert.equal(directoryLeadershipRole('Deputy Flight Commander','Alpha','Blue'),'Alpha Deputy Flight Commander');
});
