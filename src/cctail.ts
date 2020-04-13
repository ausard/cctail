#!/usr/bin/env node

import path from 'path';
import prompts, { Choice } from 'prompts';
import chalk from 'chalk';
import fs from 'fs';
import moment from 'moment';
import yargs from 'yargs';
import s from 'underscore.string';

import logfetcher from './lib/logfetcher';
import logparser from './lib/logparser';
import logemitter from './lib/logemitter';
import { LogConfig, LogFile, DwJson } from './lib/types';



const { log } = console;

const initialBytesRead = 20000;
const pollingSeconds = 3;

let profiles: LogConfig;
let fileobjs: LogFile[] = [];
let profile: DwJson;
let debug = false;

let run = async function () {

  let packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'UTF-8'));

  log(`cctail - v${packageJson.version} - (c) openmind`);

  readLogConf();

  if (Object.keys(profiles).length === 0) {
    readDwJson();
  }

  const args = yargs.argv

  if (args.d) {
    debug = true;
  }

  if (Object.keys(profiles).length === 1) {
    profile = profiles[Object.keys(profiles)[0]];
  }
  else {
    let profilename = args._[0];
    if (profilename === undefined) {
      const profileselection = await prompts({
        type: 'select',
        name: 'value',
        message: 'Select a profile:',
        choices: Object.keys(profiles).map(i => ({
          title: `  [${i}] ${profiles[i].hostname}`,
          value: i
        }))
      });
      profilename = profileselection.value;
    }

    if (!profilename) {
      log('No profile selected, exiting\n');
      process.exit(-1);
    }

    if (!profiles[profilename]) {
      log(chalk.red(`ERROR: Specified profile ${profilename} not found.\n`))
      process.exit(0);
    }

    profile = profiles[profilename];
  }

  let data = await logfetcher.fetchLogList(profile);

  let regexp = new RegExp(`<a href="/on/demandware.servlet/webdav/Sites/Logs/(.*?)">[\\s\\S\\&\\?]*?<td align="right">(?:<tt>)?(.*?)(?:<\\/tt>)?</td>[\\s\\S\\&\\?]*?<td align="right"><tt>(.*?)</tt></td>`, 'gim');
  let match = regexp.exec(data);

  while (match != null) {
    // log(`\nparsing "${match[3]} in ${match[0]}"`)

    let filedate = moment(match[3]);

    if (match[1].substr(-4) === '.log' && filedate.isSame(moment(), 'day')) {
      fileobjs.push({
        log: match[1],
        sizestring: match[2],
        date: moment(match[3]),
        debug: debug
      });
    }
    match = regexp.exec(data);
  }

  fileobjs.sort((a, b) => b.date.unix() - a.date.unix());

  let logx: LogFile[] = [];
  let logchoiche: Choice[] = [];

  for (let i in fileobjs) {
    let sizeformatted = s.lpad(fileobjs[i].sizestring, 12);
    if (sizeformatted.trim() !== '0.0 kb') {
      sizeformatted = chalk.yellow(sizeformatted);
    }
    let dateformatted = s.lpad(fileobjs[i].date.format('YYYY-MM-DD HH:mm:ss'), 20);
    if (fileobjs[i].date.isSame(moment(), 'hour')) {
      dateformatted = chalk.yellow(dateformatted);
    }
    let logname = s.rpad(fileobjs[i].log, 70);

    logname = colorize(logname, logname);

    logchoiche.push({
      title: `${chalk.green(s.lpad(i, 2))} ${logname} ${sizeformatted}  ${dateformatted}`,
      value: i
    });
  }

  let logselection = await prompts({
    type: 'autocompleteMultiselect',
    name: 'value',
    message: `Select logs on [${chalk.green(profile.hostname)}]`,
    choices: logchoiche,
    // eslint-disable-next-line no-return-assign
    onState: ((statedata) => { statedata.value.forEach((i: Choice) => i.title = `\n${i.title}`) })
  });

  if (!logselection.value || logselection.value.length === 0) {
    log('No log selected, exiting.\n');
    process.exit(-1);
  }

  logselection.value.forEach((i: number) => {
    logx.push(fileobjs[i]);
  });


  log('\n');

  // get sizes
  await Promise.all(logx.map(async (logobj) => {
    let size = await logfetcher.fetchFileSize(profile, logobj);
    logobj.size = Math.max(size - initialBytesRead, 0);
  }));

  setImmediate(showlogs, logx)
};

let showlogs = async function (logx: LogFile[]) {
  let parsed = logemitter.sort(await logparser.process(await Promise.all(logx.map((logobj) => logfetcher.fetchLogContent(profile, logobj)))));
  logemitter.output(parsed, false, logx[0].debug);
  setTimeout(showlogs, pollingSeconds * 1000, logx);
}

function readDwJson() {
  let dwJsonPath = path.join(process.cwd(), 'dw.json');
  log(`Loading profile from ${dwJsonPath}\n`);
  try {
    const dwJson = JSON.parse(fs.readFileSync(dwJsonPath, 'UTF-8'));
    const name = dwJson.profile || dwJson.hostname.split('-')[0].split('-')[0];
    profiles[name] = dwJson;
  }
  catch (err) {
    log(chalk.red(`No log.conf.json or dw.json found in path ${process.cwd()}\n`));
    process.exit(-1);
  }
}

function colorize(logname: string, text: string) {
  if (s.contains(logname, 'error') || s.contains(logname, 'fatal')) {
    return chalk.red(text);
  }
  if (s.contains(logname, 'warn')) {
    return chalk.yellow(text);
  }
  if (s.contains(logname, 'info')) {
    return chalk.green(text);
  }
  if (s.contains(logname, 'jobs')) {
    return chalk.blue(text);
  }
  return text;
}


function readLogConf() {
  try {
    profiles = JSON.parse(fs.readFileSync(`${process.cwd()}/log.conf.json`, 'UTF-8'));
  }
  catch (err) {
    // ignore
  }
}

run();
