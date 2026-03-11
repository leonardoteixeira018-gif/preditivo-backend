function lmsrCost(q, b) {
  return b * Math.log(q.reduce((sum, qi) => sum + Math.exp(qi / b), 0));
}

function lmsrPrice(q, i, b) {
  const expSum = q.reduce((sum, qi) => sum + Math.exp(qi / b), 0);
  return Math.exp(q[i] / b) / expSum;
}

function lmsrCostForShares(q, i, shares, b) {
  const qNew = [...q];
  qNew[i] += shares;
  return lmsrCost(qNew, b) - lmsrCost(q, b);
}

module.exports = { lmsrCost, lmsrPrice, lmsrCostForShares };
