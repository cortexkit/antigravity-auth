import { expect, test } from 'bun:test'
import { isProviderSecretKey } from './provider-key-policy'

test('classifies normalized credential keys without masking diagnostic identifiers', () => {
  for (const key of [
    'sessionid',
    'sessiontoken',
    'managedprojectid',
    'project',
    'tokencount',
    'refreshcontext',
    'accesscontext',
    'fingerprint',
    'deviceid',
    'clientsecret',
    'apikey',
    'password',
  ]) {
    expect(isProviderSecretKey(key)).toBe(true)
  }
  for (const key of [
    'eventid',
    'notificationid',
    'command',
    'count',
    'code',
    'status',
  ]) {
    expect(isProviderSecretKey(key)).toBe(false)
  }
})
