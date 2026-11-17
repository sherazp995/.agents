import { describe, expect, it } from 'vitest'
import { mapPath } from '../../src/failover/paths.js'

describe('mapPath', () => {
  const homes = ['/Users/hassan', '/Users/zubair']

  it('maps a path under the other laptop home to the same place under this one', () => {
    expect(mapPath('/Users/hassan/Documents/cohabit', homes, '/Users/zubair')).toBe('/Users/zubair/Documents/cohabit')
  })

  it('maps the other home itself', () => {
    expect(mapPath('/Users/hassan', homes, '/Users/zubair')).toBe('/Users/zubair')
  })

  it('leaves a path already under this home alone', () => {
    expect(mapPath('/Users/zubair/x', homes, '/Users/zubair')).toBe('/Users/zubair/x')
  })

  it('leaves paths outside every known home alone, including a home name prefix', () => {
    expect(mapPath('/opt/repos/x', homes, '/Users/zubair')).toBe('/opt/repos/x')
    expect(mapPath('/Users/hassanx/y', homes, '/Users/zubair')).toBe('/Users/hassanx/y')
  })

  it('prefers the longest matching home', () => {
    expect(mapPath('/home/a/b/c', ['/home/a', '/home/a/b'], '/home/z')).toBe('/home/z/c')
  })
})
