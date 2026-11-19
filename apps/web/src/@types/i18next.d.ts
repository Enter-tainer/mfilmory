import type { defaultNS, ns } from './constants'
import type { AppResources } from './resources'

declare module 'i18next' {
  interface CustomTypeOptions {
    ns: typeof ns
    resources: AppResources
    defaultNS: typeof defaultNS
    // if you see an error like: "Argument of type 'DefaultTFuncReturn' is not assignable to parameter of type xyz"
    // set returnNull to false (and also in the i18next init options)
    // returnNull: false;
  }
}
