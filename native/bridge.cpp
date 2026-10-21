#include <iostream>
#include <sstream>
#include <iomanip>
#include <chrono>
// Include the pinned upstream engine in this translation unit so its internal
// search counters can be logged without changing the original source files.
#define main upstream_cli_main
#include "../vendor/nneonneo-2048-ai/2048.cpp"
#undef main

int main() {
    init_tables();
    const char* directions[] = {"up", "down", "left", "right"};
    std::string line;
    while (std::getline(std::cin, line)) {
        unsigned long long id, packed;
        std::istringstream in(line);
        if (!(in >> id >> std::hex >> packed)) return 2;
        board_t board = packed;
        auto start = std::chrono::steady_clock::now();
        int selected = -1;
        float best = 0;
        std::ostringstream scores, stats, boards;
        bool first = true;
        for (int action = 0; action < 4; action++) {
            board_t after = execute_move(action, board);
            if (after == board) continue;
            eval_state state;
            // Same adaptive depth and probability cutoff as upstream's
            // score_toplevel_move, with only diagnostic printing replaced.
            state.depth_limit = std::max(3, count_distinct_tiles(board) - 2);
            float score = score_tilechoose_node(state, after, 1.0f) + 1e-6;
            if (score > best) { best = score; selected = action; }
            if (!first) { scores << ','; stats << ','; boards << ','; }
            first = false;
            scores << '"' << directions[action] << "\":" << std::setprecision(9) << score;
            stats << '"' << directions[action] << "\":{\"depth_limit\":" << state.depth_limit
                  << ",\"max_depth_reached\":" << state.maxdepth
                  << ",\"moves_evaluated\":" << state.moves_evaled
                  << ",\"cache_hits\":" << state.cachehits << '}';
            boards << '"' << directions[action] << "\":\"" << std::hex << after << '"';
        }
        double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
        std::cout << "{\"id\":" << id << ",\"direction\":";
        if (selected < 0) std::cout << "null";
        else std::cout << '"' << directions[selected] << '"';
        std::cout << ",\"scores\":{" << scores.str() << "},\"search_by_direction\":{" << stats.str()
                  << "},\"boards_after_move\":{" << boards.str()
                  << "},\"search_ms\":" << ms << "}" << std::endl;
    }
}
