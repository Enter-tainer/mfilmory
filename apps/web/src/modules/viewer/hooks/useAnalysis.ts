import useSWR from 'swr'

import { injectConfig } from '~/config'
import { getClient } from '~/lib/client'

const canUseAnalysis = () => injectConfig.useApi || injectConfig.useCloud

export const useAnalysis = (refKey: string) => {
  return useSWR(`/api/aggregation/analysis?refKey=${refKey}`, async () => (await getClient()).analysis({ refKey }), {
    isPaused: () => !canUseAnalysis(),
  })
}
