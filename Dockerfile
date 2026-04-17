FROM heroiclabs/nakama:3.22.0

# Copy your built Tic-Tac-Toe module into the container
COPY ./modules/ /nakama/data/modules/
