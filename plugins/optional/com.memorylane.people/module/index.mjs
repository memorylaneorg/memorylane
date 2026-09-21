export async function activate(){ return { async call(method){ if(method==="status") return {ready:true}; throw new Error(`Unknown method: ${method}`); } }; }
