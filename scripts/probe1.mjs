import fs from 'node:fs';
const p = 'D:\\应用信息互联\\data\\files\\hzcu\\B_S架构应用开发\\实验报告模板-B01116-BS架构应用开发(1).docx';
console.log('literal exists', fs.existsSync(p));
console.log('argv exists', fs.existsSync(process.argv[2] || ''));
console.log('argv=', JSON.stringify(process.argv[2]));
console.log('dir sample', fs.readdirSync('D:\\应用信息互联\\data\\files\\hzcu\\B_S架构应用开发').slice(0, 5));
