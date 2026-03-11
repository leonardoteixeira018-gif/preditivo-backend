const math = {
  cost(qYes, qNo, b) {
    return b * Math.log(Math.exp(qYes / b) + Math.exp(qNo / b));
  },

  probYes(qYes, qNo, b) {
    const expY = Math.exp(qYes / b);
    const expN = Math.exp(qNo / b);
    return expY / (expY + expN);
  },

  probNo(qYes, qNo, b) {
    return 1 - this.probYes(qYes, qNo, b);
  },

  buyCost(qYes, qNo, b, side, shares) {
    const costBefore = this.cost(qYes, qNo, b);
    let newQYes = qYes;
    let newQNo = qNo;

    if (side === true) {
      newQYes = qYes + shares;
    } else {
      newQNo = qNo + shares;
    }

    const costAfter = this.cost(newQYes, newQNo, b);
    const cost = costAfter - costBefore;
    const newProb = side === true
      ? this.probYes(newQYes, newQNo, b)
      : this.probNo(newQYes, newQNo, b);

    return { cost, newQYes, newQNo, newProb };
  },

  sharesForAmount(qYes, qNo, b, side, amount) {
    let low = 0;
    let high = amount * 10;

    for (let i = 0; i < 64; i++) {
      const mid = (low + high) / 2;
      const { cost } = this.buyCost(qYes, qNo, b, side, mid);
      if (cost < amount) {
        low = mid;
      } else {
        high = mid;
      }
    }

    return (low + high) / 2;
  }
};

module.exports = math;
