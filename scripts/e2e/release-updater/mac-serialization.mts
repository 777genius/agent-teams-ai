// tsx/esbuild preserves nested callback names with a compiler helper. The signed
// app's lexical frame must not be expected to supply or replace that helper.
export function macSerializedFunction(value: { toString(): string }) {
  return `((__name)=>(${value.toString()}))((target,value)=>Object.defineProperty(target,'name',{value,configurable:true}))`;
}
