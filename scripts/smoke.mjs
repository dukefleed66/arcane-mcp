import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
const client=new Client({name:'arcane-smoke',version:'0.1.0'});
await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/server.mjs',import.meta.url))]}));
try {
  const list=await client.listTools();
  console.log('MCP handshake OK;',list.tools.length,'tools');
  const read=await client.callTool({name:'arcane_operations',arguments:{search:'containers',readOnly:true}});
  if(read.isError)throw Error(read.content[0].text);
  console.log('Discovery OK;',JSON.parse(read.content[0].text).operations.length,'container read operations');
  const invalid=await client.callTool({name:'arcane_describe',arguments:{operationId:'missing'}});
  if(!invalid.isError)throw Error('Invalid operation was accepted');
  if(process.argv.includes('--live')){
    const call=async(name,args)=>{
      const r=await client.callTool({name,arguments:args});
      if(r.isError)throw Error(r.content[0].text);
      return JSON.parse(r.content[0].text);
    };
    const connection=await call('arcane_connection',{});
    console.log(connection);
    if(connection.health?.status!=='UP'||connection.catalog?.verified!==true)throw Error('Arcane health or schema version mismatch');
    const environments=await call('arcane_read',{operationId:'listEnvironments',query:{limit:100}});
    console.log(environments.data.map(e=>({id:e.id,name:e.name,status:e.status})));
    const environment=environments.data[0];
    if(!environment)throw Error('No Arcane environment was discovered');
    for(const operationId of ['list-containers','list-projects','list-images']){
      await call('arcane_describe',{operationId});
      const result=await call('arcane_read',{operationId,pathParams:{id:environment.id},query:{start:0,limit:5}});
      console.log({operationId,returned:Array.isArray(result.data)?result.data.length:undefined,totalItems:result.pagination?.totalItems});
    }
  }
}finally{await client.close();}
