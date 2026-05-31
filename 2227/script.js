const MAX_DIGITS = 15;

const state = {
  currentValue: "0",
  previousValue: null,
  operator: null,
  shouldResetDisplay: false,
  isError: false,
  lastOperand: null,
  lastOperator: null,
};

const expressionEl = document.getElementById("expression");
const resultEl = document.getElementById("result");

function formatNumber(str) {
  if (str === "Error") return str;
  if (str === "Infinity" || str === "-Infinity") return "Error";
  if (str === "NaN") return "Error";
  const num = parseFloat(str);
  if (!isFinite(num)) return "Error";
  if (Number.isInteger(num) && Math.abs(num) < 1e15) {
    return String(num);
  }
  const fixed = num.toPrecision(12);
  return String(parseFloat(fixed));
}

function updateDisplay() {
  if (state.isError) {
    resultEl.textContent = "Error";
    resultEl.style.color = "#e94560";
  } else {
    resultEl.textContent = state.currentValue;
    resultEl.style.color = "";
  }
}

function clearError() {
  if (state.isError) {
    state.isError = false;
    state.currentValue = "0";
    state.previousValue = null;
    state.operator = null;
    state.lastOperand = null;
    state.lastOperator = null;
    state.shouldResetDisplay = false;
    expressionEl.textContent = "";
  }
}

function appendDigit(digit) {
  clearError();
  if (state.shouldResetDisplay) {
    state.currentValue = digit;
    state.shouldResetDisplay = false;
  } else {
    if (digit === "0" && state.currentValue === "0") return;
    state.currentValue = state.currentValue === "0" ? digit : state.currentValue + digit;
  }
  state.currentValue = state.currentValue.slice(0, MAX_DIGITS);
  updateDisplay();
}

function handleDecimal() {
  clearError();
  if (state.shouldResetDisplay) {
    state.currentValue = "0.";
    state.shouldResetDisplay = false;
    updateDisplay();
    return;
  }
  if (!state.currentValue.includes(".")) {
    state.currentValue += ".";
  }
  updateDisplay();
}

function handleBackspace() {
  clearError();
  if (state.shouldResetDisplay) return;
  if (state.currentValue.length <= 1 || (state.currentValue.length === 2 && state.currentValue.startsWith("-"))) {
    state.currentValue = "0";
  } else {
    state.currentValue = state.currentValue.slice(0, -1);
  }
  updateDisplay();
}

function handleOperator(op) {
  clearError();
  const current = parseFloat(state.currentValue);
  if (state.operator && !state.shouldResetDisplay) {
    compute();
  }
  state.previousValue = current;
  state.operator = op;
  state.shouldResetDisplay = true;
  expressionEl.textContent = `${formatNumber(String(current))} ${op}`;
}

function compute() {
  const prev = state.previousValue;
  const current = parseFloat(state.currentValue);
  if (prev === null) return;

  let result;
  switch (state.operator) {
    case "+": result = prev + current; break;
    case "-": result = prev - current; break;
    case "*": result = prev * current; break;
    case "/":
      if (current === 0) {
        state.isError = true;
        state.currentValue = "Error";
        state.operator = null;
        state.previousValue = null;
        updateDisplay();
        return;
      }
      result = prev / current;
      break;
    default: return;
  }

  state.lastOperand = current;
  state.lastOperator = state.operator;
  state.currentValue = formatNumber(String(result));
  state.operator = null;
  state.previousValue = null;
  state.shouldResetDisplay = true;
  expressionEl.textContent = "";
  updateDisplay();
}

function handleEquals() {
  clearError();
  if (state.operator) {
    compute();
  } else if (state.lastOperator !== null && state.lastOperand !== null) {
    state.previousValue = parseFloat(state.currentValue);
    state.operator = state.lastOperator;
    compute();
  }
}

function handleClear() {
  state.currentValue = "0";
  state.previousValue = null;
  state.operator = null;
  state.lastOperand = null;
  state.lastOperator = null;
  state.shouldResetDisplay = false;
  state.isError = false;
  expressionEl.textContent = "";
  resultEl.style.color = "";
  updateDisplay();
}

function handleSign() {
  if (state.isError) return;
  if (state.shouldResetDisplay) return;
  state.currentValue = String(-parseFloat(state.currentValue));
  updateDisplay();
}

function handlePercent() {
  if (state.isError) return;
  const num = parseFloat(state.currentValue);
  if (state.operator && state.previousValue !== null) {
    const adjusted = state.previousValue * (num / 100);
    state.currentValue = formatNumber(String(adjusted));
  } else {
    state.currentValue = formatNumber(String(num / 100));
  }
  updateDisplay();
}

document.getElementById("buttons").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;

  const action = btn.dataset.action;
  switch (action) {
    case "digit": appendDigit(btn.dataset.value); break;
    case "decimal": handleDecimal(); break;
    case "backspace": handleBackspace(); break;
    case "operator": handleOperator(btn.dataset.value); break;
    case "equals": handleEquals(); break;
    case "clear": handleClear(); break;
    case "sign": handleSign(); break;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key >= "0" && e.key <= "9") {
    appendDigit(e.key);
    return;
  }
  switch (e.key) {
    case ".": handleDecimal(); break;
    case "Backspace": handleBackspace(); break;
    case "Delete": handleClear(); break;
    case "Escape": handleClear(); break;
    case "Enter":
    case "=": handleEquals(); break;
    case "+": handleOperator("+"); break;
    case "-": handleOperator("-"); break;
    case "*": handleOperator("*"); break;
    case "/": handleOperator("/"); break;
  }
});
