// Keep a harness compiler's callback-name helper inside the serialized closure.
// Never read or replace a helper in the original packaged application's scope.
export function serializedFunction(value: (...args: never[]) => unknown) {
  return `((__name)=>(${value.toString()}))((target,value)=>Object.defineProperty(target,'name',{value,configurable:true}))`;
}
