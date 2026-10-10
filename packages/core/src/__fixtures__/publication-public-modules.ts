import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as NativeFs from '../common-auth-embedded/fs/index.js'
import type * as NativeStore from '../common-auth-embedded/store/index.js'
import {
  admitPublicConsumer,
  requirePublicConsumerRoot,
} from './common-auth-public-consumer.test.ts'

export async function publicationPublicModules(root: string | undefined) {
  const consumer = requirePublicConsumerRoot(root)
  await admitPublicConsumer(consumer)
  const store: typeof NativeStore = await import(
    pathToFileURL(join(consumer, 'store-bridge.mjs')).href
  )
  const fs: typeof NativeFs = await import(
    pathToFileURL(join(consumer, 'fs-bridge.mjs')).href
  )
  return { store, fs, consumer }
}
