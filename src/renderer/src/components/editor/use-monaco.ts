import { useEffect, useState } from 'react'
import { ensureMonaco, type MonacoModule } from '@/lib/monaco-lazy'

// Why: Monaco loads on demand (F3). Components await this hook at mount and
// render a placeholder until `monaco` is available; behavior is unchanged
// after load because setup runs exactly once via the ensureMonaco singleton.
export function useMonaco(): MonacoModule | null {
  const [monaco, setMonaco] = useState<MonacoModule | null>(null)
  useEffect(() => {
    let cancelled = false
    void ensureMonaco().then((module) => {
      if (!cancelled) {
        setMonaco(module)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])
  return monaco
}
