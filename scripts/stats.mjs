import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/context.db');
const q = (s) => db.prepare(s).get().c;
console.log(JSON.stringify({
  courses: q('select count(*) c from tron_courses'),
  files: q('select count(*) c from tron_files'),
  filesLocal: q("select count(*) c from tron_files where local_path is not null and local_path <> ''"),
  liveDocs: q("select count(*) c from documents where COALESCE(json_extract(meta,'$.dupOf'),'') = ''"),
  extracted: q("select count(*) c from documents where source='hzcu' and length(body) > 100"),
}, null, 1));
