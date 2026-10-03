#!/usr/bin/env node
import {main} from '../src/command.mjs'
try { process.exitCode = await main(process.argv.slice(2)) }
catch { console.error('[runtime-diagnostic] command_failed'); process.exitCode = 2 }
