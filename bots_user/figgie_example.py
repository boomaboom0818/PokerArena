from pokerarena.figgie import FiggieBot


class FiggieExample(FiggieBot):
    name = "figgie_example"

    def on_update(self, s):
        odds = s.goal_odds()                     # P(goal suit) from your own hand
        goal = max(odds, key=odds.get)
        value = {suit: p * 10 for suit, p in odds.items()}

        # Buy the likely goal suit when it is cheap, sell the rest when someone pays up.
        if s.book[goal].ask and s.book[goal].ask < value[goal] + 3:
            self.buy(goal)
            return
        for suit, n in s.hand.items():
            if suit != goal and n and s.book[suit].bid and s.book[suit].bid > value[suit] + 1:
                self.sell(suit)
                return
        if not s.my_quotes:
            self.bid(goal, max(1, int(value[goal])))
