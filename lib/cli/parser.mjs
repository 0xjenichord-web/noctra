export function parseArgs(args) {
  const result = { command: null, positional: [], flags: {} };
  let i = 0;

  while (i < args.length && !args[i].startsWith('-')) {
    if (result.command === null) result.command = args[i];
    else result.positional.push(args[i]);
    i++;
  }

  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const flagName = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        result.flags[flagName] = args[i + 1];
        i += 2;
      } else {
        result.flags[flagName] = true;
        i++;
      }
    } else if (arg.startsWith('-')) {
      result.flags[arg.slice(1)] = true;
      i++;
    } else {
      result.positional.push(arg);
      i++;
    }
  }
  return result;
}
