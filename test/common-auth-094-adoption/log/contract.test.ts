import { test } from 'bun:test'
import { caseNames, runCase } from './contract.mjs'

for (const name of caseNames) test(name, () => runCase(name))
