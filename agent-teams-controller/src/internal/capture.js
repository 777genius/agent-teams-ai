function captureStreamOutput(stream, fn) {
  let output = '';
  const originalWrite = stream.write.bind(stream);

  stream.write = ((chunk, encoding, callback) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(encoding || 'utf8');
    if (typeof callback === 'function') {
      callback();
    }
    return true;
  });

  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.finally(() => {
        stream.write = originalWrite;
      }).then((value) => ({ value, output }));
    }

    stream.write = originalWrite;
    return { value: result, output };
  } catch (error) {
    stream.write = originalWrite;
    throw error;
  }
}

module.exports = {
  captureStreamOutput,
};
