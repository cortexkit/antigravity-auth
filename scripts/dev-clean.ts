import { removeDevSymlink } from './dev.ts'

if (import.meta.main) {
  if (removeDevSymlink()) {
    console.log('[dev] development symlink removed')
  } else {
    console.log('[dev] no development symlink found')
  }
}
